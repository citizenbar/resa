// =====================================================================
// SUPABASE CLIENT — initialisation
// =====================================================================
// Le SDK est chargé via CDN dans index.html (avant ce script) :
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
// Il expose le global `supabase` (la factory `supabase.createClient`).
//
// Ce fichier instancie le client à partir de window.CONFIG et l'expose en
// window.sb pour storage.js / auth.js / les modules.
//
// ÉTAT : câblage minimal prêt. La logique métier (storage.js, auth.js) reste
// en stub tant que le projet Supabase n'existe pas.
// =====================================================================

window.sb = null;

(function initSupabase(){
  if (!window.CONFIG || !window.CONFIG.isConfigured) {
    // Pas de credentials -> on n'instancie pas. La bannière (router.js) prévient.
    console.warn('[supabase] CONFIG non renseignée — client non initialisé. Voir public/js/config.js.');
    return;
  }
  if (typeof supabase === 'undefined' || !supabase.createClient) {
    console.error('[supabase] SDK non chargé. Vérifie le <script> CDN dans index.html.');
    return;
  }
  window.sb = supabase.createClient(
    window.CONFIG.supabaseUrl,
    window.CONFIG.supabaseAnonKey,
    {
      auth: {
        persistSession: true,       // session admin conservée entre rechargements
        autoRefreshToken: true,
        detectSessionInUrl: true,   // pour les liens magic-link / recovery
      },
    }
  );
})();

// Garde-fou : vrai uniquement si le client a pu être instancié.
window.SB_READY = !!window.sb;
