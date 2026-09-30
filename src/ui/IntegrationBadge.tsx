/**
 * The "Integration" mark next to a name (Wave 36, D287): an account that is an AI client or script
 * acting through its keys, not a person. Shown wherever people are shown (the Access sheet, comments,
 * card and note authors, whiteboard owners) so nobody mistakes its work for a person's.
 */
export function IntegrationBadge({ className = "" }: { className?: string }) {
  return <span className={`integration-badge${className ? ` ${className}` : ""}`} title="An integration: an AI client or script using its own API keys, not a person">Integration</span>;
}
