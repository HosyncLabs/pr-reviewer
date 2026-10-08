# PR Reviewer

A Manifest V3 extension built with TypeScript and React that organizes PR files into **Documentation**, **Implementation**, **Migrations**, and **Tests**. Organization runs locally. Optional per-file AI review uses your OpenAI, Gemini, or Claude API key through the extension's background worker.

## Install in Chrome

Requires Node.js 22 or later and Chrome 140 or later.

```sh
npm ci
npm run check
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this project's `dist` folder.
3. Open a PR on `github.com` and click **Organize PR** in the bottom-right corner.
4. In **Files changed**, search, filter, expand groups, and open a file. The panel stays open while navigating, retains the search, filters, and list position, and highlights the selected file. With AI off, focus stays on its link inside the panel so you can continue navigating with the keyboard. With automatic AI enabled, opening a file shows its review; manual mode provides an Analyze file button.
5. Use **Adjust category** to save a category or subcategory correction. **Automatic** removes the correction; preferences persist by repository and path across PRs and reloads.

**Collapse panel** (») folds the panel horizontally into a 48 px rail at the right edge, keeping its height and position. **Expand panel** («) restores the current search, filters, group state, scroll position, and AI review without regenerating it. The rail also has a close button; closing remains separate from collapsing.

After editing, run `npm run build`, reload the extension in `chrome://extensions`, and reload the GitHub tab. Reloading the extension disconnects panels already open in GitHub; **Reload GitHub tab** reconnects an affected panel. The page only reloads when you choose to do so.

If **Organize PR** does not appear after reloading, open PR Reviewer's **Details → Site access** in Chrome and check whether access to `https://github.com/*` is enabled. A disabled GitHub permission prevents Chrome from injecting the panel. The optional AI provider permissions are separate and do not enable GitHub access.

Public PR used to inspect both interfaces: [microsoft/TypeScript #64644](https://github.com/microsoft/TypeScript/pull/64644). The classic route is `/files`; the new authenticated interface uses `/changes`.

## Demo without installation

```sh
npm run demo
```

Open [the local demo](http://127.0.0.1:4173). It uses the same content script with test data and a demo message adapter. It is a simulated PR, with no installed extension. You can check groups, search, navigation, corrections, themes, and preservation of drafts and Viewed state. **Enable sample AI** opts into deterministic, explicitly simulated review responses. The sample **Add comment** action opens a simulated native line editor, and **Reviewed** collapses blocks in green. The demo never accepts an API key or sends requests to any AI provider. The demo is excluded from `dist`.

## Optional AI review

Open the panel's **Settings**, choose **OpenAI**, **Gemini**, or **Claude**, enter that provider's API key, choose a model and response language, enable AI review, and save. Allow access to the selected provider when Chrome prompts. Each provider keeps its own saved key and model; switching the dropdown previews its settings, and **Save settings** activates it. Existing OpenAI keys, models, and language preferences are preserved. A blank key field keeps that provider's saved key. **Remove API key** clears only the selected provider. AI stays disabled until it is configured; file organization works without a key.

The model dropdown changes with the provider. OpenAI retains GPT-6 Luna (default), GPT-6.1 Sol, and GPT-6 Astra. Gemini and Claude offer their own model presets. **Custom model…** accepts a model ID from the selected provider: it must support that API's JSON structured outputs (and low reasoning effort for OpenAI). Saved custom IDs remain selected when settings reopen. Changing the provider, model, or response language cancels active requests and clears cached reviews. Reviews are sent only to the selected provider; a failed request never falls back to another provider.

Choose **English** or **Español** in **AI response language** for summaries, highlights, and review focus. AI-generated comment drafts use the same language. English is the default for new and existing settings. Saving a different language refreshes the current review and clears cached reviews while preserving your key and model. The extension interface stays in English.

After rebuilding an unpacked extension, click **Reload** for PR Reviewer in `chrome://extensions`, then reload the GitHub tab. The panel's **LOCAL · 0.3.1** badge identifies the current content UI, including token-free module review and loaded-diff fallback when optional GitHub API access fails; an existing tab can keep an older UI even after the extension reloads. **Refresh review** refreshes the analysis, not the extension code. Chrome can also continue running an older background worker while the settings page loads newer files from disk. The settings page warns when the running worker does not recognize saved settings; the panel refuses AI reviews from an older worker that does not report a language. A current review shows the provider, model, and **English** or **Español**.

Automatic mode reviews the opened file's rendered diff. Manual mode waits for **Analyze file**; optional API context and module review are described below. The result contains a summary, highlights, and suggested review focus. Each highlight and focus point includes references such as **New L42** or **Old L38**, distinguishing current code from original code. Click a highlight or focus card to jump to its first reference in GitHub; click a **New L42** or **Old L38** chip to jump to that specific line. The panel stays open and keeps the review, drafts, and Viewed state. Original and new lines are separate targets, including when their numbers match. If a referenced line is no longer rendered, the panel asks you to load or expand its diff and try again. References are checked against the loaded diff; a point without a verified reference shows **Line reference unavailable**. Soft violet, blue, and amber cards distinguish the summary, highlights, and review focus in both themes. Default mode sends the selected path and available diff snippet to the selected AI provider. Optional module mode includes the chosen changed files; optional API context adds nearby source. Native drafts, private notes, and completion marks are never sent to AI. If GitHub has not rendered the full diff or the snippet exceeds the context limit, the panel labels the analysis as partial. Native GitHub diffs and review controls remain available alongside the analysis.

Every Summary, Highlight, and Review focus block includes **Add comment** and **Reviewed**. The AI prepares a concise, constructive question or suggestion alongside the review. **Add comment** opens GitHub's native editor at the point's first verified line and fills an empty editor with that editable draft. Summary and points without verified lines use a file-level comment. Nothing is posted or submitted automatically. Existing text is preserved; the suggested comment remains available in the panel when another draft or unavailable native controls prevent opening the editor. **Reviewed** turns a block green and collapses it. **Show** reopens it and **Undo reviewed** removes the mark. When **Save progress and notes** is enabled, marks survive file switches, refreshed identical findings, and reloads. A changed diff reopens the file and its blocks, preserving notes. New observed PR heads mark older completion as pending until each opened file is revalidated; unchanged diffs keep their marks. If head metadata is unavailable, revalidation happens when opening the file. Block marks remain independent of native Viewed status.

Switching files cancels the previous analysis and ignores late results. With local caching enabled, unchanged provider/model/language/context/checklist reviews are saved for up to seven days across worker restarts, with a maximum of 30 analyses. **Refresh review** requests a new analysis and counts toward the daily request limit. Use **Refresh review** after loading more lines, or **Retry review** after expanding an unavailable diff. The **Files** tab retains your groups, search, and list position.

Each API key is kept in local extension storage restricted to trusted extension contexts, and requests run in the background worker. The GitHub page and content script receive status and review results, never any key. This protects access to the key; local storage is not encrypted. OpenAI requests use `store: false`, which does not establish Zero Data Retention. Each provider applies its own API data policies and billing to your account. Reviews are suggestions and are not posted as GitHub comments.

## Configurable review workflow (0.3.0)

All controls are in **Settings**. Existing provider keys, models, and response language are preserved.

| Setting | Default | Behavior |
| --- | --- | --- |
| Save progress and notes | On | Local Reviewed/Dismiss marks, file completion, notes, and Resume last file. Revalidates changed diffs. |
| Next pending navigation | On | Jump to the next incomplete file, filter Pending only, and count completion per module. Whole-file completion is explicit. |
| Sync with GitHub Viewed | Off | A whole-file completion click also updates the available native Viewed checkbox; block completion never does. |
| Prioritize sensitive paths | Off | Access/isolation, money, database, and deleted-file paths sort ahead of others. Heuristic labels are separate from change-volume heat. |
| Finding details | On | Possible bug/question/suggestion, high/medium/low severity, and evidence. Dismiss irrelevant blocks or undo dismissal. |
| Add suggestion | On | Safe, AI-proposed single changed-line replacements open editable GitHub suggestion drafts. Unverified references and Markdown fence injection are rejected. |
| Repository checklists | Off | Add one criterion per line for owner/repo in Settings. Track checks per file; AI receives criteria, never notes or completion marks. |
| Automatic analysis | On | Turn off to analyze only after pressing Analyze file or Analyze module. Enabling AI itself still requires an API key. |
| GitHub API context | Off | Optionally fetch the API diff and bounded source around changed lines. Source is pinned to the PR head, including forks. Access failures fall back to loaded Changes diffs. |
| Module review | Off | Manually analyze loaded Changes diffs in the feature/package without a GitHub token; select related files from other modules/packages to compare contracts, types, callers and tests. Unloaded files are disclosed. |
| Cache AI reviews | On | Reuse identical analyses locally across reloads; display whether a review is cached and provider-reported token usage when available. |

Limits default to **60,000 context characters**, **4,000 output tokens**, **12 files per module**, and **30 surrounding lines**. Daily requests default to **0 (unlimited)**; choose a limit to bound new API attempts across tabs. Failed attempts also count; cached reads do not. The counter resets at UTC midnight. Token usage is provider-reported, not an estimated currency price.

**File and module reviews can read GitHub’s loaded Changes diffs without a GitHub token.** Leave **Use GitHub API diff and surrounding source** off to avoid GitHub API requests. Module review reads already rendered text diffs without clicking files, expanding collapsed sections, or changing drafts. Unloaded or unreadable files and configured limits are disclosed; load/expand missing diffs and refresh to include them. Optional API context can include patches and source not rendered on the page. For API context in private repositories, add an optional **GitHub token** with **Pull requests: read** and **Contents: read** for the PR and source repository. Public repositories can work without a token, subject to GitHub limits. If API access fails, review continues with loaded changes and a warning; mismatched API revisions are still rejected. The token is stored in trusted local extension storage, never returned to the content script or sent to an AI provider. Clearing or disabling AI leaves file organization available. **Local data** lets you clear cached reviews or saved progress/notes; repository criteria are managed separately.

**Add comment** and **Add suggestion** open native editable drafts. Publishing and submitting a review remain explicit GitHub actions.

## Classification

Priority: manual correction → repository rules → SQL files → README/CHANGELOG → test/spec names, snapshots, and test/fixture folders → Markdown/MDX or the docs folder → Implementation.

Files ending in `.sql`, including `.down.sql` and uppercase extensions, automatically belong to **Migrations**. Filters and manual corrections include this category; an explicit correction or rule takes precedence.

**Implementation** is divided into **Backend / API**, **Frontend**, **Scripts**, **Types**, and **Other**, with expandable groups and counts. Scripts and Types take precedence over backend/frontend folders: `backend/scripts/proxy.cjs` belongs to Scripts, and `frontend/src/types/reservation.ts` belongs to Types. The backend/server/api and frontend/client/web/ui folders identify each area; UI extensions also classify standalone files. Remaining files belong to Other. You can correct the subcategory through **Adjust category** without changing the main category.

**Backend / API** contains module groups: `backend/src/api/v1/commission/sync.ts` appears under **API › v1 › Commission**, and `backend/src/db/schemas/model.ts` under **DB**. Groups use the actual module directory and preserve the API version; files at the root belong to **General**. Search and filters retain these groups and show matching file counts.

**Frontend** also groups files by module: `frontend/src/app/dashboard/reservations/components/Calendar.tsx` appears under **Reservations**, alongside **Invoices**, **Reports**, **Settings**, and other feature directories. Shared folders such as **Components**, **Hooks**, **Fetchers**, **I18n**, and **Styles** have their own groups. Route containers (`src`, `app`, `pages`, `dashboard`, etc.), Next route groups, and dynamic segments are excluded from module names; files without a module directory appear under **General**.

In monorepos, paths under `packages/` use **the package as the module**, taking precedence over its internal folders: `packages/mira-widgets/src/components/Button.tsx` and `packages/mira-widgets/src/state.ts` belong to **mira-widgets**, while **mira-editor** and **mira-api** are separate modules. Names, hyphens, and scopes (`packages/@scope/mira-editor`) are preserved; distinct roots stay separate. Package names containing the tokens `api`, `backend`, or `server` identify Backend/API, while `frontend`, `client`, `web`, `ui`, `widgets`, or `editor` identify Frontend. Specific Scripts/Types classification and manual corrections keep their priority. Scripts, Types, and Other also show package modules when present; files outside packages appear under General within those mixed groups. Documentation, Tests, and Migrations retain their categories.

By default, within each category or module, files are sorted by the number of changed lines (**added + deleted**), highest first, and display their counts. Ties are sorted by path. If GitHub does not expose complete statistics for a file, it appears at the end with **No statistics**; totals are never inferred from a partially rendered diff. Search and corrections preserve this order.

Each file's name, icon, border, and total use a heat scale: **red** for more than 500 changes, **orange** for 251–500, **yellow** for 101–250, and **blue** for 1–100. Zero changes and unknown statistics use a neutral color. The legend and numeric total explain the scale in both themes; the total's tooltip identifies its range. Added and deleted counts retain their own colors.

For example, `docs/client.test.ts` belongs to Tests, and `tests/README.md` belongs to Documentation. Renamed files are classified by their detected current path.

Rules are serializable, ordered, case-insensitive regular expressions. You can configure them through the extension's background service worker DevTools console (open its inspector in `chrome://extensions`); there is no rule editor yet:

```js
chrome.storage.local.set({
  'pr-reviewer:repo:owner/repo': {
    rules: [{ pattern: '^qa/', category: 'tests' }]
  }
});
```

Valid categories: `documentation`, `implementation`, `migrations`, `tests`. Invalid patterns are ignored, and manual corrections always take precedence. Each file has its own storage key so two tabs cannot overwrite corrections for different files.

Reload the GitHub tab after changing rules through DevTools.

## Integration and scope

The adapter reads the inventory embedded in GitHub's React page, validating that it belongs to the current PR and comparison. It also reads full paths and anchors from the native file tree, classic view metadata, and diff headers. This lists files whose diffs have not rendered yet or whose folders are collapsed in the original tree. Opening a file uses native controls to expand its ancestor folders and navigate to the diff. The panel lives in a Shadow DOM. A debounced observer incorporates inventory changes and ignores panel mutations. Leaving the PR removes the panel and observers. Navigation events and a URL check every 750 ms detect internal navigation from any GitHub page. Native tab identity prevents stale files from being attributed to a new PR.

The inventory uses page metadata, with the native tree and diffs present in the DOM as fallbacks. Files can be detected without opening them individually. If filters or loading prevent GitHub from exposing the complete inventory and its counter is higher, the panel marks the list as partial. If the counter is unrecognized, it reports only the number of detected files. It does not request a remote inventory.

Typing in the panel's search field or changing a category does not trigger GitHub keyboard shortcuts. Native editing, selection, paste, and Tab navigation remain available. Escape closes the panel without triggering GitHub shortcuts; Escape used during input composition leaves the panel open. Keyboard events outside the panel's editable controls remain unchanged.

Filters affect the panel list. GitHub's diff blocks remain in their original order and are never hidden or replaced. Organization and review navigation preserve comments and Viewed state. **Add comment** changes only an empty native draft after a user click; posting remains in GitHub’s controls. **Return to original view** and Escape close the panel.

Permissions: a content script restricted to `https://github.com/*` to detect internal navigation, and `storage` for preferences and AI configuration. Host access to `api.openai.com`, `generativelanguage.googleapis.com`, and `api.anthropic.com` is optional. The options page requests the selected provider’s access when enabling AI and optional `api.github.com` access only for GitHub API context. Module review alone does not request GitHub API permission; removing a provider key revokes only that provider's permission. Without AI enabled, organization makes no network requests. Repository preferences are exposed through a message bridge; protected local storage, including the API key, is unavailable to content scripts. Optional cached review results, progress, checklists, and private notes are persisted locally and can be cleared in Settings. Diff source and native comment drafts are not persisted by the extension; cached findings may contain quoted code. The extension does not add telemetry or publish GitHub comments.

## Validation

`npm run check` runs TypeScript, builds the bundle, and verifies classification, conflicts, rules, PR routes, both DOM structures, exact references, search, repository persistence, added files, and SPA navigation. Integration tests run the production bundle with jsdom and verify that original tables, drafts, and Viewed controls retain their identity and state. They cover subcategories, Backend/API and Frontend modules, monorepo packages, change sorting and heat levels (including boundaries, ties, zero, unknown data, and updated statistics), and persistent corrections. One regression reproduces a tree of 144 files with a single rendered diff, diff replacement, tree navigation, and a PR switch. Another checks embedded inventory with collapsed folders and asynchronous ancestor expansion while navigating, preserving panel search, counts, scroll, and focus.

The AI integration uses mocked status and review responses. Workflow regressions cover manual mode, persistent progress and notes, next pending navigation, optional Viewed sync, dismissal, editable suggestions, related-package line navigation, stale API context rejection, bounded GitHub patches/source, worker restart caching, daily request limits, and settings migration/privacy. Comment tests cover original/new line targeting, hover-mounted React editors, editable draft insertion, preservation of existing text, file comments, cancellation, and no automatic publishing. Block actions are tested for collapse, reopening, and unchanged Viewed state. It checks selected-file context, cancellation when switching files, rejection of stale results, repeated-file deduplication, provider switching, separate key/model profiles, legacy OpenAI migration, provider-specific permissions and response formats, truncation/refusal handling, language persistence and prompt selection, and exclusion of API keys and review drafts from page messages. Other integration fixtures leave AI unconfigured. The local demo's AI output is also simulated; neither requires API usage.

The installed Chrome extension was checked against a real PR with 144 files. The complete inventory shows 85 Implementation files: Backend/API 34, Frontend 47, Scripts 2, and Types 2. Backend/API includes Commission, Control, Invoice, Payment, Reports, Reservation, Reservation commission, Sales channels, Settings, and DB modules. The earlier virtualization fix also retained the inventory when navigating to an unrendered README.

These checks do not replace testing the installed Chrome extension. Load `dist` and verify:

- Opening Files changed directly and entering from Conversation or another GitHub page.
- Switching PRs without stale files or duplicate panels.
- Loading additional files and displaying the partial inventory notice.
- Navigating to diffs, using the keyboard, and switching between light and dark themes.
- Comments, line selections, and Viewed state in an authenticated session.
- Optional AI settings, partial diff labels, and review updates when switching files.

File and module reviews use rendered text diffs from the current Changes comparison; files that GitHub has not loaded or expanded are disclosed. Optional GitHub API context retrieves PR patches and nearby source at the verified head; omitted or truncated patches and unavailable source are disclosed. Binary files, files beyond GitHub’s 3,000-file API limit, and arbitrary unchanged repository dependencies are not analyzed. API context requires the full PR comparison without commit filters and checks loaded lines against the API revision before sending them to AI. If API access fails, the extension reviews loaded changes instead.

## Integration references

- [GitHub PR files API](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files)
- [GitHub repository contents API](https://docs.github.com/en/rest/repos/contents#get-repository-content)
- [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Chrome permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [OpenAI Responses structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)
- [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/generate-content/structured-output)
- [Claude structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [OpenAI gpt-6-luna model](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [OpenAI gpt-6.1-sol model](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [OpenAI gpt-6-astra model](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [GitHub's new Files changed page](https://github.blog/changelog/2026-01-22-improved-pull-request-files-changed-page-on-by-default/)
