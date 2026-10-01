import 'server-only';

import { hasChosenFile } from './attachment-rules';
import type { AttachedSubjectKind } from './attached-files-schema';
import { attachStoredFile } from './attached-files-service';

/**
 * The optional file input on a create form (a build, a closed test run, a
 * raised bug): when a file was chosen it is attached to the record the form
 * just created, through the same door as the standalone "Attach a file" form.
 * A form with no file chosen is `none`, so adding the input changes nothing for
 * a person who does not use it.
 */
export type ChosenFileOutcome = { status: 'none' } | { status: 'attached'; fileName: string } | { status: 'refused'; message: string };

export async function attachChosenFile(formData: FormData, subjectKind: AttachedSubjectKind, subjectId: string, field = 'file'): Promise<ChosenFileOutcome> {
  const file = formData.get(field);
  if (!hasChosenFile(file)) return { status: 'none' };
  const result = await attachStoredFile({ subjectKind, subjectId }, file);
  return result.ok ? { status: 'attached', fileName: result.data.fileName } : { status: 'refused', message: result.error.message };
}
