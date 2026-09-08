-- =====================================================================
-- ÉDITION D'UNE FICHE PAR L'ADMIN (septembre 2026)
-- =====================================================================
-- À exécuter dans le SQL Editor de Supabase, APRÈS rc-rules-2026-09.sql,
-- op-photo-2026-09.sql ET restrict-admin-emails.sql. Rejouable.
--
-- BESOIN : aujourd'hui l'admin ne sait que valider, refuser, supprimer. Si un
-- intervenant se trompe d'horaire, écrit son nom de travers ou colle un lien
-- mort, il faut supprimer le créneau, en regénérer un, et lui redemander de
-- tout ressaisir. Sur 5 à 6 events par semaine, ça arrivera.
--
-- DEUX OBSTACLES DU SCHÉMA EXISTANT, qui expliquent la forme retenue :
--
--   1. Les tables *_contacts n'ont AUCUNE policy UPDATE. Elles n'ont qu'un
--      SELECT (opc_sel_admin, rcc_sel_admin, evc_sel_admin). L'admin ne peut
--      donc pas corriger un email ou un téléphone en direct.
--
--   2. Les trois tables portent un CHECK "event_date >= current_date"
--      (op_not_past, rc_not_past, ev_not_past). Postgres revérifie ce CHECK à
--      chaque UPDATE de la ligne : toute modification d'un event passé échoue,
--      même sans toucher à la date. C'est le piège n°5 de MIGRATIONS.md.
--
-- FORME RETENUE : trois RPC en security definer, une par module, qui écrivent
-- la table vitrine ET la table contacts dans la même transaction. C'est le
-- style déjà employé partout ici pour les écritures multi-tables, et ça évite
-- d'ouvrir des policies UPDATE larges sur les données personnelles.
--
-- ---------------------------------------------------------------------
-- POURQUOI is_admin() ET NON auth.uid() is not null
-- ---------------------------------------------------------------------
-- Point CRITIQUE. Ces fonctions sont en SECURITY DEFINER : elles contournent
-- les RLS. Leur garde d'entrée est donc la SEULE protection.
--
-- Depuis l'activation de « Sign in with Google », Supabase crée un compte à la
-- première connexion réussie : TOUT titulaire d'un compte Google devient
-- `authenticated`, donc auth.uid() est non nul pour lui. Une garde du type
-- `if auth.uid() is null then raise ...` laisserait donc n'importe quel compte
-- Google réécrire les fiches de tout le monde (horaires, liens, coordonnées).
-- Vérifié : sur un Postgres jetable, cette version laisse un compte hors liste
-- blanche réécrire une fiche ET les coordonnées de contact.
--
-- On réutilise is_admin() (restrict-admin-emails.sql), qui compare l'identité
-- du JWT à la liste blanche admin_emails et vérifie l'état réel du compte.
-- Le grant `to authenticated` ne suffit PAS et ne suffira jamais seul ici.
--
-- CE QUI N'EST PAS MODIFIABLE, VOLONTAIREMENT :
--   - la DATE d'un créneau. La changer peut violer rc_one_per_day,
--     op_no_overlap ou les CHECK de date, et revient à créer un autre créneau.
--     Pour déplacer une soirée : supprimer et recréer.
--   - le CODE Events et code_used. Le code est à usage unique, le rouvrir
--     casserait la garantie.
--   - le STATUT. Il a déjà ses boutons Valider / Refuser.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- EVENTS
-- ---------------------------------------------------------------------
create or replace function ev_admin_update(
  p_id uuid,
  p_soiree text, p_dj_nom text, p_debut time, p_fin time,
  p_styles text, p_format text,
  p_instagram text, p_soundcloud text, p_photo text,
  p_email text, p_tel text, p_remarques text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  -- security definer contourne les RLS : l'autorisation se vérifie ICI, et
  -- sur l'IDENTITÉ (liste blanche), pas sur le simple fait d'être connecté.
  if not is_admin() then
    raise exception 'not_admin' using errcode = 'P0001';
  end if;

  update ev_slots set
    soiree = p_soiree, dj_nom = p_dj_nom, debut = p_debut, fin = p_fin,
    styles = p_styles, format = p_format,
    instagram = p_instagram, soundcloud = p_soundcloud, photo = p_photo
  where id = p_id;

  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  insert into ev_contacts(slot_id, email, tel, remarques)
    values (p_id, p_email, p_tel, p_remarques)
    on conflict (slot_id) do update set
      email = excluded.email, tel = excluded.tel, remarques = excluded.remarques;

-- On n'intercepte QUE la contrainte de date, nommément, et on re-lève le reste.
-- ev_not_past est aujourd'hui le seul CHECK d'ev_slots, mais un `when
-- check_violation` global renommerait 'past' TOUTE contrainte ajoutée plus tard
-- (un ordre debut/fin, par exemple) : l'admin lirait « event passé » sur une
-- erreur d'horaire, message faux et débogage impossible. Le `raise` nu préserve
-- l'erreur d'origine.
exception when check_violation then
  if sqlerrm like '%ev_not_past%' then
    raise exception 'past' using errcode = 'P0001';
  end if;
  raise;
end $$;

-- ---------------------------------------------------------------------
-- OPEN PLATINE
-- ---------------------------------------------------------------------
create or replace function op_admin_update(
  p_id uuid,
  p_dj_nom text, p_styles text, p_debut_min int, p_duree_min int,
  p_instagram text, p_photo text,
  p_email text, p_tel text, p_remarques text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'not_admin' using errcode = 'P0001';
  end if;

  update op_slots set
    dj_nom = p_dj_nom, styles = p_styles,
    debut_min = p_debut_min, duree_min = p_duree_min,
    instagram = p_instagram, photo = p_photo
  where id = p_id;

  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  insert into op_contacts(slot_id, email, tel, remarques)
    values (p_id, p_email, p_tel, p_remarques)
    on conflict (slot_id) do update set
      email = excluded.email, tel = excluded.tel, remarques = excluded.remarques;

exception
  -- op_no_overlap : le nouvel horaire recouvre un autre set du même soir.
  when exclusion_violation then
    raise exception 'overlap' using errcode = 'P0001';
  -- Les deux CHECK possibles sont distingués : l'admin doit savoir s'il a
  -- saisi un horaire hors fenêtre (corrigeable) ou touché un event passé
  -- (non corrigeable). Les confondre rend le message inexploitable.
  when check_violation then
    if sqlerrm like '%op_not_past%' then
      raise exception 'past' using errcode = 'P0001';
    elsif sqlerrm like '%op_within_window%' then
      raise exception 'window' using errcode = 'P0001';
    end if;
    raise;
end $$;

-- ---------------------------------------------------------------------
-- RADIO CAMPUS
-- ---------------------------------------------------------------------
create or replace function rc_admin_update(
  p_id uuid,
  p_emission text, p_animateur text, p_style text,
  p_micros text, p_materiel text, p_photo text,
  p_email text, p_tel text, p_remarques text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'not_admin' using errcode = 'P0001';
  end if;

  update rc_reservations set
    emission = p_emission, animateur = p_animateur, style = p_style,
    micros = p_micros, materiel = p_materiel, photo = p_photo
  where id = p_id;

  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  insert into rc_contacts(reservation_id, email, tel, remarques)
    values (p_id, p_email, p_tel, p_remarques)
    on conflict (reservation_id) do update set
      email = excluded.email, tel = excluded.tel, remarques = excluded.remarques;

exception when check_violation then
  if sqlerrm like '%rc_not_past%' then
    raise exception 'past' using errcode = 'P0001';
  end if;
  raise;
end $$;

-- ---------------------------------------------------------------------
-- DROITS — authenticated UNIQUEMENT
-- ---------------------------------------------------------------------
-- Règle du projet (piège n°3 de MIGRATIONS.md) : Postgres accorde EXECUTE à
-- PUBLIC par défaut sur toute nouvelle fonction. Sans le revoke, anon
-- hériterait du droit d'appeler ces RPC. Le revoke est la première barrière,
-- is_admin() dans le corps est la seconde.
revoke all on function ev_admin_update(uuid,text,text,time,time,text,text,text,text,text,text,text,text) from public;
revoke all on function ev_admin_update(uuid,text,text,time,time,text,text,text,text,text,text,text,text) from anon;
grant execute on function ev_admin_update(uuid,text,text,time,time,text,text,text,text,text,text,text,text) to authenticated;

revoke all on function op_admin_update(uuid,text,text,int,int,text,text,text,text,text) from public;
revoke all on function op_admin_update(uuid,text,text,int,int,text,text,text,text,text) from anon;
grant execute on function op_admin_update(uuid,text,text,int,int,text,text,text,text,text) to authenticated;

revoke all on function rc_admin_update(uuid,text,text,text,text,text,text,text,text,text) from public;
revoke all on function rc_admin_update(uuid,text,text,text,text,text,text,text,text,text) from anon;
grant execute on function rc_admin_update(uuid,text,text,text,text,text,text,text,text,text) to authenticated;

commit;

-- =====================================================================
-- VÉRIFICATION (SQL Editor)
-- =====================================================================
-- 1. La dépendance est-elle bien là ? (ce fichier en dépend entièrement)
--   select proname from pg_proc where proname = 'is_admin';   -- 1 ligne
--
-- 2. anon est-il refusé ?
--   set role anon;
--     select ev_admin_update('00000000-0000-0000-0000-000000000000'::uuid,
--       'x','x',null,null,'','','','','','','','');
--        -- doit ÉCHOUER : permission denied for function
--   reset role;
--
-- 3. CONTRÔLE CLÉ — un compte connecté mais HORS liste blanche doit être
--    refusé. C'est ce que la version d'origine de ce fichier (auth.uid() is
--    null) laissait passer, et c'est le seul test qui le prouve.
--    Depuis le NAVIGATEUR, connecté avec un compte Google quelconque :
--      -> modifier une fiche doit échouer avec 'not_admin'
--    Puis connecté avec un compte de la liste blanche admin_emails :
--      -> la même modification doit réussir.
--
-- 4. Un event passé refuse l'écriture (CHECK *_not_past), avec le message
--    'past' et non une erreur Postgres brute.
-- =====================================================================
