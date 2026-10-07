export const CATEGORY_ORDER = ["documentation", "implementation", "migrations", "tests"] as const;
export type Category = (typeof CATEGORY_ORDER)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  documentation: "Documentation",
  implementation: "Implementation",
  migrations: "Migrations",
  tests: "Tests",
};

export const IMPLEMENTATION_GROUP_ORDER = ["backend", "frontend", "scripts", "types", "other"] as const;
export type ImplementationGroup = (typeof IMPLEMENTATION_GROUP_ORDER)[number];

export const IMPLEMENTATION_GROUP_LABELS: Record<ImplementationGroup, string> = {
  backend: "Backend / API",
  frontend: "Frontend",
  scripts: "Scripts",
  types: "Types",
  other: "Other",
};

export function isImplementationGroup(value: unknown): value is ImplementationGroup {
  return IMPLEMENTATION_GROUP_ORDER.some((group) => group === value);
}

export function classifyImplementation(
  path: string,
  overrides: Record<string, ImplementationGroup> = {},
): ImplementationGroup {
  const manual = Object.hasOwn(overrides, path) ? overrides[path] : undefined;
  if (isImplementationGroup(manual)) return manual;

  const segments = path.replaceAll("\\", "/").toLowerCase().split("/");
  const name = segments.at(-1) ?? "";
  const folders = segments.slice(0, -1);
  if (folders.some((part) => /^(scripts|bin|tools|tasks)$/.test(part)) || /\.(sh|bash|zsh|ps1)$/.test(name)) return "scripts";
  if (folders.some((part) => /^(types|typings|interfaces)$/.test(part)) || name === "types.ts" || /(?:\.types\.|\.d\.ts$)/.test(name)) return "types";
  if (folders.some((part) => /^(backend|server|api)$/.test(part))) return "backend";
  const packageName = getPackageModule(path).split("/").at(-1)?.toLowerCase() ?? "";
  if (/(?:^|[-_.])(api|backend|server)(?:[-_.]|$)/.test(packageName)) return "backend";
  if (/(?:^|[-_.])(frontend|client|web|ui|widgets|editor)(?:[-_.]|$)/.test(packageName)) return "frontend";
  if (folders.some((part) => /^(frontend|client|web|ui)$/.test(part)) || /\.(jsx|tsx|vue|svelte|css|scss|html)$/.test(name)) return "frontend";
  return "other";
}

/** Preserve the package's real name and root, including scoped package directories. */
export function getPackageModule(path: string): string {
  const folders = path.replaceAll("\\", "/").split("/").slice(0, -1);
  const packages = folders.findIndex((part) => part.toLowerCase() === "packages");
  const name = folders[packages + 1];
  if (packages === -1 || !name) return "";
  if (name.startsWith("@")) {
    if (name.length === 1 || !folders[packages + 2]) return "";
    return folders.slice(0, packages + 3).join("/");
  }
  return folders.slice(0, packages + 2).join("/");
}

/** Group by real directories; files directly under the backend belong to General. */
export function getBackendModule(path: string): string {
  const packageModule = getPackageModule(path);
  if (packageModule) return packageModule;
  const folders = path.replaceAll("\\", "/").toLowerCase().split("/").slice(0, -1);
  const api = folders.indexOf("api");
  if (api !== -1) {
    const versioned = /^v\d+$/.test(folders[api + 1] ?? "");
    return folders.slice(api, api + (versioned ? 3 : 2)).join("/");
  }
  const backend = folders.findIndex((part) => part === "backend" || part === "server");
  if (backend === -1) return "";
  const module = backend + (folders[backend + 1] === "src" ? 2 : 1);
  return folders[module] ?? "";
}

/** Route containers and dynamic segments are context, not feature modules. */
export function getFrontendModule(path: string): string {
  const packageModule = getPackageModule(path);
  if (packageModule) return packageModule;
  const folders = path.replaceAll("\\", "/").toLowerCase().split("/").slice(0, -1);
  const frontend = folders.findIndex((part) => /^(frontend|client|web|ui)$/.test(part));
  const relative = folders.slice(frontend + 1);
  if (relative[0] === "src") relative.shift();
  return relative.find((part) => part && !/^(app|pages|routes|features|modules|dashboard)$/.test(part) && !/^\(.*\)$/.test(part) && !/^\[.*\]$/.test(part)) ?? "";
}

export type CategoryOverrides = Record<string, Category>;
export type ClassificationRule = { pattern: string; category: Category };

export function isCategory(value: unknown): value is Category {
  return CATEGORY_ORDER.some((category) => category === value);
}

/** Use the current path for renamed files. Manual corrections match the exact repository path. */
export function classifyFile(
  path: string,
  overrides: CategoryOverrides = {},
  rules: readonly ClassificationRule[] = [],
): Category {
  const manual = Object.hasOwn(overrides, path) ? overrides[path] : undefined;
  if (isCategory(manual)) return manual;

  const normalized = path.replaceAll("\\", "/");
  for (const rule of rules) {
    if (!isCategory(rule.category)) continue;
    try {
      if (new RegExp(rule.pattern, "i").test(normalized)) return rule.category;
    } catch {
      // Invalid saved patterns must not prevent grouping the rest of the PR.
    }
  }

  const segments = normalized.toLowerCase().split("/");
  const name = segments.at(-1) ?? "";
  if (name.endsWith(".sql")) return "migrations";
  // README/CHANGELOG win over tests; explicit tests and test folders win over Markdown/docs.
  if (/^(readme|changelog)(?:[._-]|$)/.test(name)) return "documentation";
  if (/(?:^|[._-])(test|spec)(?:[._-]|$)/.test(name) || name.endsWith(".snap")) return "tests";
  if (segments.slice(0, -1).some((part) => /^(tests?|specs?|pruebas|__tests__|snapshots|__snapshots__|fixtures|__fixtures__)$/.test(part))) return "tests";
  if (/\.mdx?$/.test(name) || segments.slice(0, -1).includes("docs")) return "documentation";
  return "implementation";
}
