# ADR 0001 : héberger sur Vercel + Supabase plutôt que tout regrouper sur Cloudflare

- **Statut** : accepté
- **Date** : 2026-08-29
- **Portée** : hébergement du front, des fonctions serveur, de la base et du stockage

## Contexte

Le projet tourne aujourd'hui sur deux fournisseurs :

- **Vercel** : sert le site statique (`public/`) et deux fonctions Node
  (`api/events.js`, `api/upload-photo.js`). Projet `prog.citizenbar.fr`.
- **Supabase** : Postgres, PostgREST, Auth, Storage. Projet en région
  Central EU (Frankfurt).

**Cloudflare est déjà présent, mais uniquement comme DNS** du domaine
`citizenbar.fr`. Vérifié le 2026-08-29 : `citizenbar.fr` répond
`Server: cloudflare` avec un en-tête `CF-RAY`, tandis que `prog.citizenbar.fr`
répond `Server: Vercel` sans en-tête Cloudflare. Le sous-domaine de la prog
pointe donc sur Vercel en DNS-only (sans proxy).

D'où la question posée : puisque Cloudflare est déjà là, peut-on tout y
regrouper (Pages + Workers + D1 + R2) en restant sur les offres gratuites, et
n'avoir qu'un seul fournisseur ?

## Décision

**On garde Vercel + Supabase.** On ne migre ni la base, ni le stockage, ni
l'authentification vers Cloudflare.

Cloudflare reste le DNS, ce qui est son rôle actuel et convient.

## Justification

Migrer est techniquement possible et resterait gratuit : sur le volume d'un bar
(quelques créneaux par semaine), les offres gratuites de Pages, Workers, D1 et
R2 sont très largement suffisantes. **Le coût de la migration n'est donc pas
financier, il est dans la sécurité.**

Ce qu'on perdrait, et qui devrait être réécrit en logique applicative :

1. **Les garanties d'intégrité au niveau de la base.** D1 est du SQLite. On perd
   la contrainte d'exclusion `gist` qui rend l'anti-chevauchement d'Open Platine
   infalsifiable côté serveur, l'index unique partiel de Radio Campus
   (un créneau par jour, un refus rouvre la date) et l'`enum` `booking_status`.
   Ces règles redeviendraient du code, donc contournables.
2. **Tout le modèle de sécurité.** D1 n'a ni RLS, ni grants au niveau colonne, ni
   fonctions `SECURITY DEFINER`. Les policies, les RPC atomiques
   (`op_request`, `ev_fill_slot`, `ev_can_upload`) et la séparation
   public / contacts devraient être reconstruites dans les Workers.
3. **L'authentification admin.** Supabase Auth serait à remplacer
   (Cloudflare Access, ou du JWT maison).

Le point décisif : ce modèle de sécurité est la partie la plus travaillée du
projet, et **deux failles réelles y ont déjà été trouvées et corrigées en
production** (cf. `supabase/MIGRATIONS.md`) :

- une RPC admin exécutable par un visiteur anonyme, faute de `revoke public`
  avant `grant` ;
- le code Events à 6 chiffres et les notes internes lisibles en anonyme, parce
  que la RLS filtre la ligne et non la colonne.

Ces deux corrections tiennent aujourd'hui parce que Postgres les applique. Les
réécrire en logique applicative, c'est réintroduire exactement la classe de
risque qu'on a mis deux correctifs à fermer. Le gain visé (un fournisseur en
moins, facture inchangée) ne le justifie pas.

Un facteur de calendrier a aussi pesé : au moment de la décision, il ne restait
qu'un bucket Storage à créer pour que tout soit fonctionnel. Changer
d'architecture à cet instant aurait fait repartir le projet de bien plus loin.

## Conséquences

**Positif**

- Le modèle de sécurité reste appliqué par Postgres, pas par du code applicatif.
- Aucune réécriture, aucune régression fonctionnelle à craindre.
- Le coût reste nul (offres gratuites des deux côtés).

**Négatif, assumé**

- Deux comptes fournisseurs à administrer au lieu d'un (trois avec le DNS).
- Deux endroits où regarder en cas de panne.
- Deux fournisseurs dont dépendre.

**Neutre**

- Les fonctions dans `api/` utilisent l'API Node (`require('crypto')`,
  `req.on('data')`). Elles ne sont pas portables telles quelles vers les
  Workers : une migration future impliquerait de les réécrire.

## Alternatives écartées

**Tout migrer sur Cloudflare (Pages + Workers + D1 + R2).** Écarté pour les
raisons ci-dessus : gratuit mais coûteux en réécriture de la sécurité.

**Migrer seulement le calcul (front + fonctions) vers Cloudflare Pages/Workers,
en gardant Supabase pour la base, l'auth et le stockage.** Écarté *pour
l'instant*, mais c'est **l'option à réexaminer en premier** si l'objectif de
consolidation revient. Elle ne touche à aucune ligne du modèle de sécurité ;
son seul coût est la réécriture des deux fonctions au format Workers. À
reconsidérer après la recette complète, jamais avant.

**Passer `prog.citizenbar.fr` en proxy Cloudflare (orange cloud) devant
Vercel.** Hors périmètre de cette ADR, mais possible indépendamment si on veut
du cache ou une protection Cloudflare devant le site. À noter : cela ajouterait
un intermédiaire devant les en-têtes déjà posés par `vercel.json`, à vérifier le
cas échéant.

## Révision

Rouvrir cette décision si l'un de ces éléments change :

- l'offre gratuite de Vercel ou de Supabase cesse de couvrir l'usage ;
- D1 acquiert un équivalent crédible des RLS et des grants colonne ;
- un besoin d'agents Cloudflare (Workers AI, MCP) devient central pour le
  projet, auquel cas c'est l'alternative « calcul seulement » qu'il faut
  instruire d'abord.
