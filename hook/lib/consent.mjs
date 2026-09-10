// The consent text shown once at first run. One paragraph, states exactly what
// is captured and the retention period from config. Kept in one place so
// setup.mjs, the /xrpl-setup skill and PRIVACY.md say the same thing.

export function consentText(config) {
  const event = config.event && !/REPLACE-ME/i.test(config.event) ? config.event : "this event";
  const days = Number(config.retention_days) || 90;
  return (
    `This project takes part in XRPL developer experience research for ${event}. ` +
    "If you consent, a hook in your coding agent records, first to a local file in this project and then to the organizer's server: " +
    "prompts and tool outputs that mention XRPL (transaction types, result codes, xrpl.org URLs, XRPL packages), truncated; " +
    "XRPL packages you install; retry counts and time to first success per transaction type; " +
    "short structured notes your agent writes about XRPL friction it observed; " +
    "and anything you submit yourself with /xrpl-feedback or /xrpl-session-analysis. " +
    "Nothing without an XRPL keyword is stored. File contents, git history, environment variables, names and emails are never collected, " +
    "and a redaction pass removes seeds, keys and tokens before anything is written. " +
    "You are identified only by a random pseudonym and your team name; in a small cohort that pair may still identify you to the organizer. " +
    `Data is kept for ${days} days and used for developer experience reporting only. ` +
    "You can stop at any time by deleting .xrpl-devex/identity.json in this project or removing the hooks from your agent settings."
  );
}
