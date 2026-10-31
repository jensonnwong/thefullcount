/* The Full Count · settings
   The game saves teams to Supabase. The publishable key below is meant to be public:
   the browser can only call the game's own database functions, which check each team's PIN.
   Never put a secret or service_role key in this file. */
window.FC_CONFIG = {
  backend: 'auto',
  supabaseUrl: 'https://bekcyzospcruszqtpcpe.supabase.co',
  supabaseAnonKey: 'sb_publishable_eHpZIgofIqg32ncq3B73fw_vXdNbdzY'
};
