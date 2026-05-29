-- =====================================================================
-- Citizen Bar / resa — RLS + RPC
-- =====================================================================
-- À exécuter APRÈS schema.sql.
--
-- Modèle de sécurité :
--   - Lecture PUBLIQUE (anon) : seulement les lignes 'validated', et JAMAIS
--     les tables *_contacts. Le portail lit la vue public_agenda.
--   - Écriture INVITÉ (anon) : passe par des fonctions SECURITY DEFINER qui
--     contrôlent tout (statut forcé 'pending', anti-chevauchement atomique,
--     écriture slot+contacts en une transaction). Pas d'insert/update direct.
--   - Écriture ADMIN (authenticated) : validate / refuse / delete réservés
--     aux utilisateurs connectés via Supabase Auth.
--
-- Le compte admin se crée dans Supabase : Authentication → Users → Add user.
-- =====================================================================

alter table op_slots        enable row level security;
alter table op_contacts     enable row level security;
alter table rc_reservations enable row level security;
alter table rc_contacts     enable row level security;
alter table ev_slots        enable row level security;
alter table ev_contacts     enable row level security;

-- ---------------------------------------------------------------------
-- LECTURE
-- ---------------------------------------------------------------------
-- Public (anon + authenticated) : uniquement les lignes validées des tables
-- "vitrine". Les codes Events ne fuient pas : on lit ces colonnes via la vue,
-- mais 'code' n'y figure pas. La lecture anon de ev_slots reste limitée aux
-- lignes validées, donc un code non encore validé n'est pas listable.
drop policy if exists op_sel_validated on op_slots;
drop policy if exists rc_sel_validated on rc_reservations;
drop policy if exists ev_sel_validated on ev_slots;
create policy op_sel_validated on op_slots        for select using (status = 'validated');
create policy rc_sel_validated on rc_reservations for select using (status = 'validated');
create policy ev_sel_validated on ev_slots        for select using (status = 'validated');

-- Admin : lecture complète (toutes lignes + contacts).
drop policy if exists op_sel_admin on op_slots;
drop policy if exists rc_sel_admin on rc_reservations;
drop policy if exists ev_sel_admin on ev_slots;
drop policy if exists opc_sel_admin on op_contacts;
drop policy if exists rcc_sel_admin on rc_contacts;
drop policy if exists evc_sel_admin on ev_contacts;
create policy op_sel_admin  on op_slots        for select to authenticated using (true);
create policy rc_sel_admin  on rc_reservations for select to authenticated using (true);
create policy ev_sel_admin  on ev_slots        for select to authenticated using (true);
create policy opc_sel_admin on op_contacts     for select to authenticated using (true);
create policy rcc_sel_admin on rc_contacts     for select to authenticated using (true);
create policy evc_sel_admin on ev_contacts     for select to authenticated using (true);

-- ---------------------------------------------------------------------
-- UPDATE / DELETE — ADMIN uniquement (validate / refuse / delete)
-- ---------------------------------------------------------------------
drop policy if exists op_upd_admin on op_slots;
drop policy if exists rc_upd_admin on rc_reservations;
drop policy if exists ev_upd_admin on ev_slots;
create policy op_upd_admin on op_slots        for update to authenticated using (true) with check (true);
create policy rc_upd_admin on rc_reservations for update to authenticated using (true) with check (true);
create policy ev_upd_admin on ev_slots        for update to authenticated using (true) with check (true);

drop policy if exists op_del_admin on op_slots;
drop policy if exists rc_del_admin on rc_reservations;
drop policy if exists ev_del_admin on ev_slots;
create policy op_del_admin on op_slots        for delete to authenticated using (true);
create policy rc_del_admin on rc_reservations for delete to authenticated using (true);
create policy ev_del_admin on ev_slots        for delete to authenticated using (true);

-- Admin : création de slot Events (avec code) en direct.
drop policy if exists ev_ins_admin on ev_slots;
create policy ev_ins_admin on ev_slots for insert to authenticated with check (true);

-- NB : aucune policy insert anon sur les tables. Les invités passent par les
-- RPC ci-dessous (SECURITY DEFINER = elles tournent avec les droits du
-- propriétaire, en contournant les RLS de façon contrôlée).

-- =====================================================================
-- RPC — OPEN PLATINE : réservation invité (atomique, anti-chevauchement)
-- =====================================================================
create or replace function op_request(
  p_date date, p_debut_min int, p_duree_min int,
  p_dj_nom text, p_styles text,
  p_email text, p_tel text, p_instagram text, p_remarques text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  -- l'insert échoue (exclusion gist) si la plage chevauche un slot non refusé
  insert into op_slots(event_date, debut_min, duree_min, dj_nom, styles, status)
    values (p_date, p_debut_min, p_duree_min, p_dj_nom, p_styles, 'pending')
    returning id into v_id;
  insert into op_contacts(slot_id, email, tel, instagram, remarques)
    values (v_id, p_email, p_tel, p_instagram, p_remarques);
  return v_id;
exception when exclusion_violation then
  raise exception 'overlap' using errcode = 'P0001';
end $$;

-- =====================================================================
-- RPC — RADIO CAMPUS : réservation invité (atomique, 1/jour)
-- =====================================================================
create or replace function rc_request(
  p_date date, p_emission text, p_animateur text, p_style text,
  p_micros text, p_materiel text,
  p_email text, p_tel text, p_remarques text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into rc_reservations(event_date, emission, animateur, style, micros, materiel, status)
    values (p_date, p_emission, p_animateur, p_style, p_micros, p_materiel, 'pending')
    returning id into v_id;
  insert into rc_contacts(reservation_id, email, tel, remarques)
    values (v_id, p_email, p_tel, p_remarques);
  return v_id;
exception when unique_violation then
  raise exception 'taken' using errcode = 'P0001';
end $$;

-- =====================================================================
-- RPC — EVENTS : le DJ réclame un code (usage unique, atomique)
-- Renvoie le slot SANS le code ni données perso. Ne marque PAS encore
-- code_used (le DJ peut abandonner le form) : c'est ev_fill_slot qui scelle.
-- =====================================================================
create or replace function ev_claim_code(p_code text)
returns table(slot_id uuid, soiree text, event_date date)
language plpgsql security definer set search_path = public as $$
begin
  return query
    select s.id, s.soiree, s.event_date
      from ev_slots s
     where s.code = p_code and s.code_used = false
     limit 1;
end $$;

-- =====================================================================
-- RPC — EVENTS : le DJ remplit sa fiche (scelle le code définitivement)
-- =====================================================================
create or replace function ev_fill_slot(
  p_code text, p_dj_nom text, p_debut time, p_fin time,
  p_styles text, p_format text,
  p_email text, p_tel text, p_instagram text, p_soundcloud text, p_photo text, p_remarques text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  -- verrouille la ligne et vérifie l'usage unique en une transaction
  select id into v_id from ev_slots
    where code = p_code and code_used = false
    for update;
  if v_id is null then
    raise exception 'code_used' using errcode = 'P0001';
  end if;
  update ev_slots
    set code_used = true, dj_nom = p_dj_nom, debut = p_debut, fin = p_fin,
        styles = p_styles, format = p_format, status = 'pending'
    where id = v_id;
  insert into ev_contacts(slot_id, email, tel, instagram, soundcloud, photo, remarques)
    values (v_id, p_email, p_tel, p_instagram, p_soundcloud, p_photo, p_remarques)
    on conflict (slot_id) do update set
      email=excluded.email, tel=excluded.tel, instagram=excluded.instagram,
      soundcloud=excluded.soundcloud, photo=excluded.photo, remarques=excluded.remarques;
  return v_id;
end $$;

-- =====================================================================
-- RPC — EVENTS : génération de code admin atomique (pas de doublon)
-- =====================================================================
create or replace function ev_create_slot(p_date date, p_soiree text)
returns table(slot_id uuid, code text)
language plpgsql security definer set search_path = public as $$
declare v_code text; v_id uuid; v_try int := 0;
begin
  loop
    v_try := v_try + 1;
    v_code := lpad((floor(random()*1000000))::int::text, 6, '0');
    begin
      insert into ev_slots(event_date, soiree, code, status, dj_nom)
        values (p_date, p_soiree, v_code, 'pending', 'En attente…')
        returning id into v_id;
      exit;  -- succès
    exception when unique_violation then
      if v_try > 50 then raise exception 'code_gen_failed'; end if;
      -- sinon on retente avec un autre code
    end;
  end loop;
  return query select v_id, v_code;
end $$;

-- Droits d'exécution des RPC.
-- IMPORTANT : en Postgres, toute nouvelle fonction accorde EXECUTE à PUBLIC par
-- défaut. Un simple "grant to authenticated" ne restreint donc RIEN (anon hérite
-- de PUBLIC). Il faut d'abord RÉVOQUER PUBLIC, puis accorder explicitement.

-- RPC invité (réservation publique) : anon + authenticated, mais pas PUBLIC large.
revoke all on function op_request(date,int,int,text,text,text,text,text,text) from public;
revoke all on function rc_request(date,text,text,text,text,text,text,text,text) from public;
revoke all on function ev_claim_code(text) from public;
revoke all on function ev_fill_slot(text,text,time,time,text,text,text,text,text,text,text,text) from public;
grant execute on function op_request(date,int,int,text,text,text,text,text,text) to anon, authenticated;
grant execute on function rc_request(date,text,text,text,text,text,text,text,text) to anon, authenticated;
grant execute on function ev_claim_code(text) to anon, authenticated;
grant execute on function ev_fill_slot(text,text,time,time,text,text,text,text,text,text,text,text) to anon, authenticated;

-- RPC ADMIN (création de slot + code) : authenticated UNIQUEMENT.
-- On révoque PUBLIC et anon explicitement (sinon anon pourrait générer des codes).
revoke all on function ev_create_slot(date,text) from public;
revoke all on function ev_create_slot(date,text) from anon;
grant execute on function ev_create_slot(date,text) to authenticated;

-- =====================================================================
-- RPC — listes admin (renvoient slot + contacts en un appel, authenticated)
-- =====================================================================
-- (Optionnel : le front lit déjà les tables en direct avec les policies admin
--  ci-dessus. On garde les selects directs pour rester simple.)
