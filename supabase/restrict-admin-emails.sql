-- =====================================================================
-- SÉCURITÉ : restreindre l'admin à une liste blanche d'emails (2026-08-29)
-- =====================================================================
-- À exécuter APRÈS les migrations 1 à 6 (cf. MIGRATIONS.md). Rejouable.
--
-- LE PROBLÈME QUE CE FICHIER FERME :
--   Les policies admin disaient `to authenticated using (true)` : autrement
--   dit, TOUT utilisateur authentifié est admin. Tant que les comptes étaient
--   créés à la main et les inscriptions fermées, c'était sûr.
--
--   L'activation de « Sign in with Google » casse cette hypothèse : Supabase
--   crée un utilisateur à la PREMIÈRE connexion réussie, et il n'existe pas de
--   liste blanche native côté fournisseur. Sans le correctif ci-dessous,
--   n'importe quel titulaire d'un compte Google deviendrait `authenticated`,
--   donc admin : il pourrait lire tous les contacts (RGPD), voir les codes
--   Events, valider, refuser et supprimer des réservations.
--
-- LA PARADE :
--   On ne fait plus confiance au simple fait d'être authentifié. Une fonction
--   `is_admin()` compare l'email du JWT à une liste blanche, et TOUTES les
--   policies admin passent par elle. L'identité fait autorité, pas la session.
--
-- POURQUOI UNE TABLE ET PAS UNE LISTE EN DUR :
--   Ajouter ou retirer un admin devient un INSERT/DELETE, sans toucher aux
--   policies (donc sans risque de casser un `using` en production).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Liste blanche des emails admin.
-- ---------------------------------------------------------------------
create table if not exists admin_emails (
  email      text primary key,
  note       text,
  created_at timestamptz not null default now()
);

-- RLS active SANS aucune policy : la table devient invisible et non modifiable
-- pour anon comme pour authenticated. Seules les fonctions SECURITY DEFINER
-- (qui contournent les RLS de façon contrôlée) et l'admin du dashboard la
-- lisent. Un attaquant authentifié ne peut donc pas s'y ajouter.
alter table admin_emails enable row level security;
revoke all on table admin_emails from anon, authenticated;

-- Les deux comptes existants (relevés dans Authentication -> Users).
insert into admin_emails(email, note) values
  ('m@tthieu.fr',         'admin technique'),
  ('spectaclo@gmail.com', 'équipe bar')
on conflict (email) do nothing;

-- ---------------------------------------------------------------------
-- 2) is_admin() : vrai si l'appelant est authentifié ET dans la liste.
-- ---------------------------------------------------------------------
-- On lit l'email dans le JWT vérifié par GoTrue (auth.jwt()), pas un champ
-- fourni par le client : il est signé, donc non falsifiable.
--
-- POURQUOI ON LIT auth.users PLUTÔT QUE LE CLAIM `email_verified`.
--
--   Précision d'abord, pour ne pas laisser croire à un défaut du JWT : le JWT
--   est signé, donc INFALSIFIABLE. Personne ne peut passer email_verified de
--   false à true, ni forger un email. auth.uid() utilisé ci-dessous vient
--   d'ailleurs lui aussi du JWT, et on lui fait pleinement confiance.
--
--   Le problème n'est pas l'intégrité, c'est l'ABSENCE. La signature garantit
--   que ce qui est présent est authentique ; elle ne garantit pas qu'un claim
--   optionnel soit là. Or l'emplacement de `email_verified` (racine /
--   user_metadata / app_metadata) n'a pas pu être confirmé dans le code source
--   de GoTrue. Sur un claim absent, `->>` renvoie NULL, et il faut alors
--   choisir : traiter NULL comme "vérifié" (fail-open : un compte jamais
--   confirmé devient admin) ou comme "non vérifié" (fail-closed : plus
--   personne n'est admin si le claim n'est jamais émis). Aucun des deux n'est
--   acceptable quand on ne sait pas lequel s'applique.
--
--   `auth.users.email_confirmed_at` supprime le doute : c'est une COLONNE
--   écrite par GoTrue, non nulle si et seulement si l'adresse a été confirmée
--   (Google la remplit d'office ; un signup email non confirmé la laisse
--   NULL). Lisible ici parce que la fonction est SECURITY DEFINER.
--
--   SECOND AVANTAGE, RÉEL : la FRAÎCHEUR. Un JWT est un instantané valide ~1h.
--   Si on retire un admin de la liste, qu'on le bannit ou qu'on supprime son
--   compte, son jeton continue d'affirmer l'ancien état jusqu'à expiration.
--   La base répond au présent : c'est ce qui rend banned_until et deleted_at
--   effectifs, alors qu'ils seraient inopérants depuis un claim figé.
--
--   COÛT ASSUMÉ : une jointure sur auth.users à chaque évaluation de policy,
--   là où lire un claim serait gratuit. Négligeable au volume de ce projet.
--
-- MENACE FERMÉE : quelqu'un s'inscrit en email/mot de passe avec l'adresse
--   d'un admin sans jamais la confirmer. Son JWT porterait le bon `email`
--   (authentiquement signé), mais email_confirmed_at reste NULL -> refusé.
--   La protection ne dépend donc plus du réglage « inscriptions fermées ».
create or replace function is_admin()
returns boolean
language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1
      from auth.users u
      join admin_emails a on lower(a.email) = lower(u.email)
     where u.id = auth.uid()
       and u.email_confirmed_at is not null        -- adresse réellement confirmée
       and u.deleted_at is null                    -- compte non supprimé
       and u.is_anonymous is not true              -- pas une session anonyme
       -- banned_until est une DATE, pas un booléen : un ban expiré ne doit
       -- plus bloquer, un ban en cours doit refuser.
       and (u.banned_until is null or u.banned_until < now())
  );
$$;

-- Règle du projet : revoke public AVANT grant explicite.
revoke all on function is_admin() from public;
grant execute on function is_admin() to anon, authenticated;

-- ---------------------------------------------------------------------
-- 3) Toutes les policies admin passent par is_admin().
--    On remplace `to authenticated using (true)` par `using (is_admin())`.
-- ---------------------------------------------------------------------

-- SELECT complet (toutes lignes + contacts) : admin uniquement.
drop policy if exists op_sel_admin  on op_slots;
drop policy if exists rc_sel_admin  on rc_reservations;
drop policy if exists ev_sel_admin  on ev_slots;
drop policy if exists opc_sel_admin on op_contacts;
drop policy if exists rcc_sel_admin on rc_contacts;
drop policy if exists evc_sel_admin on ev_contacts;
create policy op_sel_admin  on op_slots        for select to authenticated using (is_admin());
create policy rc_sel_admin  on rc_reservations for select to authenticated using (is_admin());
create policy ev_sel_admin  on ev_slots        for select to authenticated using (is_admin());
create policy opc_sel_admin on op_contacts     for select to authenticated using (is_admin());
create policy rcc_sel_admin on rc_contacts     for select to authenticated using (is_admin());
create policy evc_sel_admin on ev_contacts     for select to authenticated using (is_admin());

-- UPDATE (valider / refuser).
drop policy if exists op_upd_admin on op_slots;
drop policy if exists rc_upd_admin on rc_reservations;
drop policy if exists ev_upd_admin on ev_slots;
create policy op_upd_admin on op_slots        for update to authenticated using (is_admin()) with check (is_admin());
create policy rc_upd_admin on rc_reservations for update to authenticated using (is_admin()) with check (is_admin());
create policy ev_upd_admin on ev_slots        for update to authenticated using (is_admin()) with check (is_admin());

-- DELETE.
drop policy if exists op_del_admin on op_slots;
drop policy if exists rc_del_admin on rc_reservations;
drop policy if exists ev_del_admin on ev_slots;
create policy op_del_admin on op_slots        for delete to authenticated using (is_admin());
create policy rc_del_admin on rc_reservations for delete to authenticated using (is_admin());
create policy ev_del_admin on ev_slots        for delete to authenticated using (is_admin());

-- INSERT de slot Events.
drop policy if exists ev_ins_admin on ev_slots;
create policy ev_ins_admin on ev_slots for insert to authenticated with check (is_admin());

-- ---------------------------------------------------------------------
-- 4) RPC admin : ev_create_slot génère les codes Events.
--    Le grant `to authenticated` ne suffit plus (tout compte Google est
--    authenticated) : on vérifie l'identité DANS la fonction.
-- ---------------------------------------------------------------------
create or replace function ev_create_slot(p_date date, p_soiree text)
returns table(slot_id uuid, code text)
language plpgsql security definer set search_path = public as $$
declare v_code text; v_id uuid; v_try int := 0;
begin
  if not is_admin() then
    raise exception 'not_admin' using errcode = 'P0001';
  end if;
  loop
    v_try := v_try + 1;
    v_code := lpad((floor(random()*1000000))::int::text, 6, '0');
    begin
      insert into ev_slots(event_date, soiree, code, status, dj_nom)
        values (p_date, p_soiree, v_code, 'pending', 'En attente…')
        returning id into v_id;
      exit;
    exception when unique_violation then
      if v_try > 50 then raise exception 'code_gen_failed'; end if;
    end;
  end loop;
  return query select v_id, v_code;
end $$;

revoke all on function ev_create_slot(date,text) from public;
revoke all on function ev_create_slot(date,text) from anon;
grant execute on function ev_create_slot(date,text) to authenticated;

-- =====================================================================
-- VÉRIFICATION (SQL Editor)
-- =====================================================================
--   -- la liste blanche est bien celle attendue :
--   select * from admin_emails;
--
--   -- is_admin() est faux hors session authentifiée (aucun JWT) :
--   select is_admin();            -- attendu : false
--
--   -- CONTRÔLE CLÉ : les comptes de la liste blanche ont-ils bien une adresse
--   -- confirmée ? Un admin dont email_confirmed_at serait NULL ne pourrait
--   -- PAS administrer (c'est voulu, mais autant le savoir avant de basculer).
--   select a.email,
--          u.id is not null            as compte_existe,
--          u.email_confirmed_at is not null as email_confirme,
--          u.raw_app_meta_data->>'provider' as provider
--     from admin_emails a
--     left join auth.users u on lower(u.email) = lower(a.email);
--   -- attendu : compte_existe = true ET email_confirme = true sur les 2 lignes.
--
--   -- SCÉNARIO D'ATTAQUE couvert : un compte créé avec l'adresse d'un admin
--   -- mais jamais confirmé (signup email/mot de passe). Il apparaîtrait ici
--   -- avec email_confirme = false, et is_admin() le refuse.
--
-- Le vrai test se fait dans le NAVIGATEUR, après activation de Google :
--   1. connecte-toi avec un des deux emails      -> le dashboard admin marche
--   2. connecte-toi avec un autre compte Google  -> connexion OK (Supabase crée
--      le compte) mais AUCUNE donnée admin visible, validation impossible.
--      C'est le comportement voulu : l'authentification réussit, l'autorisation
--      échoue.
--
-- POUR AJOUTER UN ADMIN plus tard (aucune policy à toucher) :
--   insert into admin_emails(email, note) values ('x@exemple.fr','...');
-- POUR EN RETIRER UN :
--   delete from admin_emails where email = 'x@exemple.fr';
-- =====================================================================
