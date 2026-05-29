-- =====================================================================
-- Citizen Bar / resa — SCHÉMA SQL (modèle relationnel)
-- =====================================================================
-- À exécuter EN PREMIER dans le SQL Editor de Supabase, PUIS policies.sql.
--
-- Décisions produit câblées dans ce schéma :
--   - REFUS : un créneau 'refused' se ROUVRE (réservable par quelqu'un d'autre).
--     -> les contraintes d'unicité/exclusion ne comptent QUE pending+validated.
--   - CODE EVENTS : mort après usage (code_used=true définitif). L'admin
--     régénère un nouveau code si besoin.
--
-- Principes de durcissement :
--   1) RGPD : les contacts (email, tél, instagram…) vivent dans des tables
--      *_contacts séparées, JAMAIS exposées en lecture publique.
--   2) Concurrence : les écritures sensibles passent par des fonctions
--      SECURITY DEFINER atomiques (voir policies.sql). Le front ne fait jamais
--      de "lire-puis-écrire" exposé aux courses.
--
-- Statuts : 'pending' (créneau bloqué) -> 'validated' (public) -> 'refused' (rouvert).
-- =====================================================================

create extension if not exists pgcrypto;     -- gen_random_uuid()
create extension if not exists btree_gist;    -- exclusion sur (date + plage horaire)

-- =====================================================================
-- ENUM statut commun
-- =====================================================================
do $$ begin
  create type booking_status as enum ('pending', 'validated', 'refused');
exception when duplicate_object then null; end $$;

-- =====================================================================
-- OPEN PLATINE — mercredis, créneaux 1h-4h, 19h30-02h00
-- =====================================================================
create table if not exists op_slots (
  id          uuid primary key default gen_random_uuid(),
  event_date  date not null,
  debut_min   int  not null,                 -- minutes depuis minuit, +24h après 00h (cf. timeToMin)
  duree_min   int  not null check (duree_min in (60,120,180,240)),
  dj_nom      text not null,                 -- nom de scène (PUBLIC)
  styles      text,                          -- (PUBLIC)
  status      booking_status not null default 'pending',
  created_at  timestamptz not null default now(),
  -- date passée interdite (couvre une session restée ouverte après minuit)
  constraint op_not_past check (event_date >= current_date),
  -- un set ne dépasse pas 02:00 (= 1560 min en +24h). 19:30 = 1170.
  constraint op_within_window check (debut_min >= 1170 and debut_min + duree_min <= 1560),
  -- ANTI-CHEVAUCHEMENT atomique : deux créneaux NON refusés le même jour ne
  -- peuvent pas se recouvrir. Un 'refused' est exclu -> il rouvre la plage.
  constraint op_no_overlap exclude using gist (
    event_date with =,
    int4range(debut_min, debut_min + duree_min) with &&
  ) where (status <> 'refused')
);
create index if not exists op_slots_date_idx on op_slots(event_date);

create table if not exists op_contacts (
  slot_id     uuid primary key references op_slots(id) on delete cascade,
  email       text,
  tel         text,
  instagram   text,
  remarques   text
);

-- =====================================================================
-- RADIO CAMPUS — un créneau / jour, mar-dim (fermé lun+mer), 19h00-21h30
-- =====================================================================
create table if not exists rc_reservations (
  id          uuid primary key default gen_random_uuid(),
  event_date  date not null,
  emission    text not null,                 -- (PUBLIC)
  animateur   text not null,                 -- (PUBLIC)
  style       text,                          -- (PUBLIC)
  micros      text,
  materiel    text,
  status      booking_status not null default 'pending',
  created_at  timestamptz not null default now(),
  constraint rc_not_past check (event_date >= current_date)
);
-- 1 seul créneau NON refusé par jour (un refus rouvre la date).
create unique index if not exists rc_one_per_day
  on rc_reservations(event_date) where (status <> 'refused');

create table if not exists rc_contacts (
  reservation_id uuid primary key references rc_reservations(id) on delete cascade,
  email       text,
  tel         text,
  remarques   text
);

-- =====================================================================
-- EVENTS — système à code. L'admin crée le slot + un code 6 chiffres unique
-- (6 chiffres : moins brute-forçable que 4). Le DJ saisit le code (usage
-- unique : code_used passe à true définitivement) et remplit sa fiche.
-- =====================================================================
create table if not exists ev_slots (
  id          uuid primary key default gen_random_uuid(),
  event_date  date not null,
  soiree      text not null,                 -- nom de la soirée (PUBLIC)
  code        char(6) not null unique,       -- code DJ
  code_used   boolean not null default false,
  dj_nom      text,                          -- rempli par le DJ (PUBLIC)
  debut       time,
  fin         time,
  styles      text,                          -- (PUBLIC)
  format      text,
  status      booking_status not null default 'pending',
  created_at  timestamptz not null default now(),
  constraint ev_not_past check (event_date >= current_date)
);
create index if not exists ev_slots_date_idx on ev_slots(event_date);

create table if not exists ev_contacts (
  slot_id     uuid primary key references ev_slots(id) on delete cascade,
  email       text,
  tel         text,
  instagram   text,
  soundcloud  text,
  photo       text,
  remarques   text
);

-- =====================================================================
-- VUE PUBLIQUE — agenda : uniquement les validés, AUCUNE donnée perso.
-- Le portail lit cette vue (un seul select). public_agenda tourne en
-- security_invoker=off implicite via une fonction si besoin ; ici on s'appuie
-- sur les RLS "select validated" des tables sous-jacentes (policies.sql).
-- =====================================================================
create or replace view public_agenda as
  select 'op'::text as module,
         event_date,
         lpad((debut_min/60 % 24)::text,2,'0') || ':' || lpad((debut_min % 60)::text,2,'0') as heure,
         debut_min as sort_min,
         dj_nom as titre,
         styles as sous_titre
    from op_slots where status = 'validated'
  union all
  select 'rc', event_date, '19:00', 19*60,
         emission, animateur || coalesce(' · ' || style, '')
    from rc_reservations where status = 'validated'
  union all
  select 'ev', event_date,
         coalesce(to_char(debut,'HH24:MI'), '21:30'),
         coalesce(extract(hour from debut)::int, 21) * 60 + coalesce(extract(minute from debut)::int, 30),
         soiree, dj_nom || coalesce(' · ' || styles, '')
    from ev_slots where status = 'validated';

-- La suite (RLS + RPC) est dans policies.sql.
