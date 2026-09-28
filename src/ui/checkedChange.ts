/**
 * A checkbox change handler that reads `checked` while the event is still live and hands the plain
 * boolean on. React clears `event.currentTarget` once dispatch ends, so reading it inside a state
 * updater (which runs later) throws: always read the value first, then call the setter.
 */
export function onCheckedChange(apply: (checked: boolean) => void) {
  return (event: { currentTarget: { checked: boolean } }) => {
    const checked = event.currentTarget.checked;
    apply(checked);
  };
}
