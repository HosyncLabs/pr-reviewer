# PR Reviewer

A Manifest V3 extension built with TypeScript and React that organizes PR files into **Documentation**, **Implementation**, **Migrations**, and **Tests**. Organization runs locally. Optional per-file AI review uses your OpenAI API key through the extension's background worker.

## Install in Chrome

Requires Node.js 22 or later and Chrome 140 or later.

```sh
npm ci
npm run check
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this project's `dist` folder.
3. Open a PR on `github.com` and click **Organize PR** in the bottom-right corner.
4. In **Files changed**, search, filter, expand groups, and open a file. The panel stays open while navigating, retains the search, filters, and list position, and highlights the selected file. With AI off, focus stays on its link inside the panel so you can continue navigating with the keyboard. With AI enabled, opening a file shows its review.
5. Use **Adjust category** to save a category or subcategory correction. **Automatic** removes the correction; preferences persist by repository and path across PRs and reloads.

After editing, run `npm run build`, reload the extension in `chrome://extensions`, and reload the GitHub tab.

If **Organize PR** does not appear after reloading, open PR Reviewer's **Details → Site access** in Chrome and check whether access to `https://github.com/*` is enabled. A disabled GitHub permission prevents Chrome from injecting the panel. The optional OpenAI permission is separate and does not enable GitHub access.

Public PR used to inspect both interfaces: [microsoft/TypeScript #64644](https://github.com/microsoft/TypeScript/pull/64644). The classic route is `/files`; the new authenticated interface uses `/changes`.

## Demo without installation

```sh
npm run demo
```

Open [the local demo](http://127.0.0.1:4173). It uses the same content script with test data and a demo message adapter. It is a simulated PR, with no installed extension. You can check groups, search, navigation, corrections, themes, and preservation of drafts and Viewed state. **Enable sample AI** opts into deterministic, explicitly simulated review responses. The demo never accepts an API key or sends requests to OpenAI. The demo is excluded from `dist`.

## Optional AI review

Open the panel's AI settings to access the extension options page. Enter your OpenAI API key, choose a model, enable AI review, and save. Allow the optional permission for `https://api.openai.com/*` when prompted. AI stays disabled until it is configured; file organization works without a key.

The **OpenAI model** dropdown offers **GPT-6 Luna** (default), **GPT-6.1 Sol**, and **GPT-6 Astra**. Choose **Custom model…** to enter another model ID that supports Responses structured outputs and low reasoning effort. Saved custom IDs remain selected when settings reopen. Changing the model keeps your saved key, clears previous cached reviews, and uses the new model for subsequent analysis.

Choose **English** or **Español** in **AI response language** for summaries, highlights, and review focus. English is the default for new and existing settings. Saving a different language refreshes the current review and clears cached reviews while preserving your key and model. The extension interface stays in English.

After rebuilding an unpacked extension, click **Reload** for PR Reviewer in `chrome://extensions`, then reload the GitHub tab. Chrome can continue running an older background worker while the settings page loads newer files from disk. The settings page now warns when the running worker does not recognize the saved language; the panel refuses AI reviews from an older worker that does not report a language. A current review shows **English** or **Español** beside the model.

Opening a file triggers a review of that file's rendered diff. The result contains a summary, highlights, and suggested review focus. The extension sends the file path and available diff snippet to OpenAI. It does not send review drafts, other repository files, or your entire PR. If GitHub has not rendered the full diff or the snippet exceeds the context limit, the panel labels the analysis as partial. Native GitHub diffs and review controls remain available alongside the analysis.

Switching files cancels the previous analysis and ignores late results. Unchanged diffs reuse results for up to ten minutes while the background worker remains active. Use **Refresh review** after loading more lines, or **Retry review** after expanding an unavailable diff. The **Files** tab retains your groups, search, and list position.

The API key is kept in local extension storage restricted to trusted extension contexts, and requests run in the background worker. The GitHub page and content script receive status and review results, never the key. This protects access to the key; local storage is not encrypted. Requests use `store: false`, which does not establish Zero Data Retention. API usage is billed to your OpenAI account. Reviews are suggestions and are not posted as GitHub comments.

## Classification

Priority: manual correction → repository rules → SQL files → README/CHANGELOG → test/spec names, snapshots, and test/fixture folders → Markdown/MDX or the docs folder → Implementation.

Files ending in `.sql`, including `.down.sql` and uppercase extensions, automatically belong to **Migrations**. Filters and manual corrections include this category; an explicit correction or rule takes precedence.

**Implementation** is divided into **Backend / API**, **Frontend**, **Scripts**, **Types**, and **Other**, with expandable groups and counts. Scripts and Types take precedence over backend/frontend folders: `backend/scripts/proxy.cjs` belongs to Scripts, and `frontend/src/types/reservation.ts` belongs to Types. The backend/server/api and frontend/client/web/ui folders identify each area; UI extensions also classify standalone files. Remaining files belong to Other. You can correct the subcategory through **Adjust category** without changing the main category.

**Backend / API** contains module groups: `backend/src/api/v1/commission/sync.ts` appears under **API › v1 › Commission**, and `backend/src/db/schemas/model.ts` under **DB**. Groups use the actual module directory and preserve the API version; files at the root belong to **General**. Search and filters retain these groups and show matching file counts.

**Frontend** also groups files by module: `frontend/src/app/dashboard/reservations/components/Calendar.tsx` appears under **Reservations**, alongside **Invoices**, **Reports**, **Settings**, and other feature directories. Shared folders such as **Components**, **Hooks**, **Fetchers**, **I18n**, and **Styles** have their own groups. Route containers (`src`, `app`, `pages`, `dashboard`, etc.), Next route groups, and dynamic segments are excluded from module names; files without a module directory appear under **General**.

In monorepos, paths under `packages/` use **the package as the module**, taking precedence over its internal folders: `packages/mira-widgets/src/components/Button.tsx` and `packages/mira-widgets/src/state.ts` belong to **mira-widgets**, while **mira-editor** and **mira-api** are separate modules. Names, hyphens, and scopes (`packages/@scope/mira-editor`) are preserved; distinct roots stay separate. Package names containing the tokens `api`, `backend`, or `server` identify Backend/API, while `frontend`, `client`, `web`, `ui`, `widgets`, or `editor` identify Frontend. Specific Scripts/Types classification and manual corrections keep their priority. Scripts, Types, and Other also show package modules when present; files outside packages appear under General within those mixed groups. Documentation, Tests, and Migrations retain their categories.

Within each category or module, files are sorted by the number of changed lines (**added + deleted**), highest first, and display their counts. Ties are sorted by path. If GitHub does not expose complete statistics for a file, it appears at the end with **No statistics**; totals are never inferred from a partially rendered diff. Search and corrections preserve this order.

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

Filters affect the panel list. GitHub's diff blocks remain in their original order and are never hidden or replaced. The panel leaves comments, line selections, and Viewed state untouched. **Return to original view** and Escape close the panel.

Permissions: a content script restricted to `https://github.com/*` to detect internal navigation, and `storage` for preferences and AI configuration. OpenAI host access is optional and requested through the extension options page. Without AI enabled, organization makes no network requests. Repository preferences are exposed through a message bridge; protected local storage, including the API key, is unavailable to content scripts. Review snippets and drafts are not persisted. The extension does not add telemetry or write GitHub comments.

## Validation

`npm run check` runs TypeScript, builds the bundle, and verifies classification, conflicts, rules, PR routes, both DOM structures, exact references, search, repository persistence, added files, and SPA navigation. Integration tests run the production bundle with jsdom and verify that original tables, drafts, and Viewed controls retain their identity and state. They cover subcategories, Backend/API and Frontend modules, monorepo packages, change sorting and heat levels (including boundaries, ties, zero, unknown data, and updated statistics), and persistent corrections. One regression reproduces a tree of 144 files with a single rendered diff, diff replacement, tree navigation, and a PR switch. Another checks embedded inventory with collapsed folders and asynchronous ancestor expansion while navigating, preserving panel search, counts, scroll, and focus.

The AI integration uses mocked status and review responses. It checks selected-file context, cancellation when switching files, rejection of stale results, repeated-file deduplication, language persistence and prompt selection, and exclusion of API keys and review drafts from page messages. Other integration fixtures leave AI unconfigured. The local demo's AI output is also simulated; neither requires API usage.

The installed Chrome extension was checked against a real PR with 144 files. The complete inventory shows 85 Implementation files: Backend/API 34, Frontend 47, Scripts 2, and Types 2. Backend/API includes Commission, Control, Invoice, Payment, Reports, Reservation, Reservation commission, Sales channels, Settings, and DB modules. The earlier virtualization fix also retained the inventory when navigating to an unrendered README.

These checks do not replace testing the installed Chrome extension. Load `dist` and verify:

- Opening Files changed directly and entering from Conversation or another GitHub page.
- Switching PRs without stale files or duplicate panels.
- Loading additional files and displaying the partial inventory notice.
- Navigating to diffs, using the keyboard, and switching between light and dark themes.
- Comments, line selections, and Viewed state in an authenticated session.
- Optional AI settings, partial diff labels, and review updates when switching files.

AI review currently uses the selected file's rendered diff. Fetching complete base/head versions, broader repository context, and server-side review tasks would require a separate integration.

## Integration references

- [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Chrome permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [OpenAI Responses structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)
- [OpenAI gpt-6-luna model](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [OpenAI gpt-6.1-sol model](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [OpenAI gpt-6-astra model](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [GitHub's new Files changed page](https://github.blog/changelog/2026-01-22-improved-pull-request-files-changed-page-on-by-default/)
