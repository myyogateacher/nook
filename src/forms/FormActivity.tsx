import { ItemTimeline } from "../ui/activity/ItemTimeline";
import { canCommentAtLevel } from "../ui/activity/activityAccess";
import { FormFrame, MissingForm, useFormDetail, type FormsNav } from "./FormsApp";
import { module as formsModule } from "./module";

/**
 * A form's Activity tab (D1375): its history (created, published, opened and closed, renamed, the
 * public link, the final time) and comments, for anyone with a level on the form. Respondents who only
 * answer have no level and never see the tab; the API answers 404 for them too (T501).
 */
export default function FormActivity({ nav, formRef }: { nav: FormsNav; formRef: string }) {
  const { form, state } = useFormDetail(formRef, nav, "activity");
  if (state === "missing" || (state === "ready" && (!form || form.level === null))) return <MissingForm nav={nav} />;
  return <FormFrame nav={nav} form={form} view="activity">
    {form ? <div className="forms-activity"><ItemTimeline kind="form" id={form.id} canComment={canCommentAtLevel(form.level)} title="Activity" renderers={formsModule.activityRenderers} /></div>
      : <p className="ui-panel-loading" role="status">Loading…</p>}
  </FormFrame>;
}
