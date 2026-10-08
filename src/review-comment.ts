import type { AIReviewLine } from './ai-protocol';
import { navigateToFile, type PullRequestFile } from './github';
import { findReviewLine, selectedDiff } from './review-context';
import { navigateToReviewLine, reviewLineHash } from './review-navigation';

const EDITOR = 'textarea:not([disabled]):not([readonly])';
const UNAVAILABLE = 'GitHub’s comment editor is unavailable. Use the suggested comment below in GitHub’s native editor.';

function visible(element: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = element.ownerDocument.defaultView?.getComputedStyle(current);
    if (current.hidden || style?.display === 'none' || style?.visibility === 'hidden') return false;
  }
  return true;
}

function matchesEditor(editor: HTMLTextAreaElement, target: HTMLElement, reference?: AIReviewLine): boolean | undefined {
  const expected = reference && `${reference.side === 'left' ? 'L' : 'R'}${reference.line}`;
  // New GitHub identifies the composer with a heading; classic GitHub uses hidden form fields.
  for (let container = editor.parentElement; container && container !== target; container = container.parentElement) {
    if (container.querySelectorAll(EDITOR).length !== 1) break;
    const heading = [...container.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],legend')]
      .map(element => element.textContent?.trim() ?? '').find(text => /^Add (?:a )?comment (?:on|to) /i.test(text));
    if (heading) return expected ? new RegExp(`\\bline ${expected}\\b`, 'i').test(heading) : /\b(?:this )?file\b/i.test(heading);
    const line = container.querySelector<HTMLInputElement>('input[name$="[line]"]')?.value;
    const side = container.querySelector<HTMLInputElement>('input[name$="[side]"]')?.value.toLowerCase();
    if (line && side) return !!reference && Number(line) === reference.line && side === reference.side;
  }
}

function editorFor(target: HTMLElement, row: Element | null, reference?: AIReviewLine): HTMLTextAreaElement | undefined {
  return [...target.querySelectorAll<HTMLTextAreaElement>(EDITOR)].filter(visible).find(editor => {
    const matched = matchesEditor(editor, target, reference);
    if (matched !== undefined) return matched;
    // A newly opened classic composer has no heading, but follows exactly one source row.
    return !!row && row.nextElementSibling?.matches('.js-inline-comments-container') === true &&
      row.nextElementSibling.contains(editor) && row.querySelectorAll('.blob-num').length === 1 &&
      editor.matches('[name="pull_request_review_comment[body]"]');
  });
}

function commentButton(target: HTMLElement, gutter: HTMLElement | null, reference?: AIReviewLine): HTMLButtonElement | undefined {
  const scope = gutter?.closest('tr,[role="row"]') ?? target;
  const candidates = [...scope.querySelectorAll<HTMLButtonElement>('button:not([disabled])')].filter(button => {
    if (button.form && button.type !== 'button') return false;
    const label = button.getAttribute('aria-label') ?? button.getAttribute('title') ?? button.textContent?.trim() ?? '';
    if (!reference) return /^Comment on this file$/i.test(label) && !button.closest('tr,[role="row"]');
    if (!button.matches('.add-line-comment,.js-add-line-comment') && !/^Add (?:a )?comment(?:\b|$)/i.test(label)) return false;
    const side = button.getAttribute('data-side')?.toLowerCase();
    if (side && side !== reference.side && side !== (reference.side === 'left' ? 'old' : 'new')) return false;
    const numbered = label.match(/\b([LR])(\d+)\b/i);
    if (numbered && (numbered[1].toUpperCase() !== (reference.side === 'left' ? 'L' : 'R') || Number(numbered[2]) !== reference.line)) return false;
    const cell = button.closest('td,[role="cell"],[role="gridcell"]');
    return !cell?.matches('.blob-num,[data-line-number]') || cell === gutter || cell.contains(gutter);
  });
  return candidates.length === 1 ? candidates[0] : candidates.find(button => gutter?.contains(button));
}

export async function openReviewComment(
  file: PullRequestFile,
  reference: AIReviewLine | undefined,
  draft: string,
  document: Document = globalThis.document,
  signal?: AbortSignal,
): Promise<'filled' | 'preserved'> {
  const window = document.defaultView;
  const route = document.URL.split('#')[0];
  const assertCurrent = () => {
    if (signal?.aborted || document.URL.split('#')[0] !== route) throw new Error('Comment cancelled because the selected file changed.');
    const selected = selectedDiff(file, document);
    if (!selected) throw new Error(UNAVAILABLE);
    return selected.target;
  };
  if (!window || !draft.trim()) throw new Error('No suggested comment is available. Refresh the review.');
  if (reference) reviewLineHash(file, reference);
  if (signal?.aborted) throw new Error('Comment cancelled.');
  // An open React composer can replace the code cell that our line adapter normally reads.
  const existing = selectedDiff(file, document);
  let editor = existing && editorFor(existing.target, null, reference);
  if (!editor) {
    const navigated = reference ? await navigateToReviewLine(file, reference, document, signal) : await navigateToFile(file, document, signal);
    if (!navigated) throw new Error(UNAVAILABLE);
  }
  const target = assertCurrent();
  const gutter = reference ? findReviewLine(file, reference, document) : null;
  const row = gutter?.closest('tr,[role="row"]') ?? null;
  editor ||= editorFor(target, row, reference);
  if (!editor) {
    // Opening another composer can discard an existing draft in GitHub.
    if ([...document.querySelectorAll<HTMLTextAreaElement>(EDITOR)].some(editor => visible(editor) && editor.value.trim())) {
      throw new Error('Finish or cancel your existing GitHub draft first. Your text was preserved; the suggestion is below.');
    }
    if (gutter) {
      gutter.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
      gutter.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }));
    }
    let button = commentButton(target, gutter, reference);
    const hoverDeadline = Date.now() + 1_000;
    while (!button && Date.now() < hoverDeadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      button = commentButton(assertCurrent(), reference ? findReviewLine(file, reference, document) : null, reference);
    }
    if (!button) throw new Error(UNAVAILABLE);
    const before = new Set(target.querySelectorAll<HTMLTextAreaElement>(EDITOR));
    assertCurrent();
    if ([...document.querySelectorAll<HTMLTextAreaElement>(EDITOR)].some(editor => visible(editor) && editor.value.trim())) {
      throw new Error('Finish or cancel your existing GitHub draft first. Your text was preserved; the suggestion is below.');
    }
    button.click();
    const deadline = Date.now() + 3_000;
    do {
      const current = assertCurrent();
      editor = editorFor(current, row, reference);
      // Accept only the single new composer inside the verified source row or file.
      if (!editor) {
        const scope = reference ? row : current;
        const created = [...scope?.querySelectorAll<HTMLTextAreaElement>(EDITOR) ?? []].filter(editor => !before.has(editor) && visible(editor) && matchesEditor(editor, current, reference) !== false);
        if (created.length === 1) editor = created[0];
      }
      if (editor) break;
      await new Promise<void>(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
  }
  if (!editor || !editor.isConnected || !assertCurrent().contains(editor)) throw new Error(UNAVAILABLE);
  const preserved = !!editor.value.trim();
  if (!preserved) {
    // The prototype setter updates React-controlled inputs without replacing GitHub’s editor.
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, draft.trim().slice(0, 2_000));
    editor.dispatchEvent(new window.Event('input', { bubbles: true }));
    editor.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  assertCurrent();
  editor.scrollIntoView({ block: 'center', behavior: 'auto' });
  editor.focus();
  return preserved ? 'preserved' : 'filled';
}
