import assert from "node:assert/strict";
import test from "node:test";
import { CATEGORY_LABELS, CATEGORY_ORDER, IMPLEMENTATION_GROUP_LABELS, IMPLEMENTATION_GROUP_ORDER, classifyFile, classifyImplementation, getBackendModule, getFrontendModule, getPackageModule, isCategory, isImplementationGroup } from "../src/classifier.ts";

test("classifies all files once with documented conflict precedence", () => {
  const examples = {
    "README": "documentation",
    "docs/README.test.ts": "documentation",
    "tests/README.md": "documentation",
    "__tests__/CHANGELOG": "documentation",
    "guide.mdx": "documentation",
    "docs/openapi.json": "documentation",
    "docs/guide.test.md": "tests",
    "docs/service.spec.ts": "tests",
    "tests/usage.md": "tests",
    "__snapshots__/output.md": "tests",
    "fixtures/example.json": "tests",
    "__fixtures__/response.json": "tests",
    "pruebas/caso.js": "tests",
    "test/parser.js": "tests",
    "component.snap": "tests",
    "src/parser.test.ts": "tests",
    "src/test_parser.py": "tests",
    "DOCS/Service.SPEC.TS": "tests",
    "TESTS/ReadMe.MD": "documentation",
    "src/contest.ts": "implementation",
    "src/parser.ts": "implementation",
    "migrations/001.sql": "migrations",
    "backend/src/db/migrations/0100_write_guard.down.sql": "migrations",
    "database/schema.SQL": "migrations",
    "backups/database.sql": "migrations",
    "tests/fixtures/schema.sql": "migrations",
    "docs/example.sql": "migrations",
    "db/migrations/run.ts": "implementation",
    "package.json": "implementation",
    "unknown": "implementation",
    "docs\\service.test.ts": "tests",
  } as const;

  for (const [path, expected] of Object.entries(examples)) {
    assert.equal(classifyFile(path), expected, path);
    assert.ok(CATEGORY_ORDER.includes(classifyFile(path)));
  }
  assert.deepEqual(CATEGORY_LABELS, {
    documentation: "Documentation",
    implementation: "Implementation",
    migrations: "Migrations",
    tests: "Tests",
  });
  assert.equal(isCategory("tests"), true);
  assert.equal(isCategory("migrations"), true);
  assert.equal(isCategory("invalid"), false);
  assert.equal(isCategory(undefined), false);
});

test("manual overrides win over ordered repository rules and defaults", () => {
  const rules = [
    { pattern: "[", category: "tests" },
    { pattern: "^integration/", category: "tests" },
    { pattern: "\\.ts$", category: "implementation" },
  ] as const;
  assert.equal(classifyFile("integration/client.ts", {}, rules), "tests");
  assert.equal(classifyFile("integration/client.ts", { "integration/client.ts": "documentation" }, rules), "documentation");
  assert.equal(classifyFile("tests/README.md", { "tests/README.md": "implementation" }), "implementation");
  assert.equal(classifyFile("README.md", { "readme.md": "tests" }), "documentation");
  assert.equal(classifyFile("toString"), "implementation");
  assert.equal(classifyFile("db/schema.sql", { "db/schema.sql": "tests" }), "tests");
  assert.equal(classifyFile("db/schema.sql", {}, [{ pattern: "^db/", category: "implementation" }]), "implementation");
  assert.equal(classifyFile("db/run.ts", {}, [{ pattern: "^db/", category: "migrations" }]), "migrations");
});

test("renames use their current path and do not inherit the previous path override", () => {
  const previousPath = "tests/client.ts";
  const currentPath = "src/client.ts";
  assert.equal(classifyFile(previousPath), "tests");
  assert.equal(classifyFile(currentPath, { [previousPath]: "documentation" }), "implementation");
});

test("implementation subgroups use exact overrides and specific folders before UI extensions", () => {
  const examples = {
    "backend/src/api/router.ts": "backend",
    "server/views/App.tsx": "backend",
    "src/api/client.ts": "backend",
    "frontend/src/App.tsx": "frontend",
    "client/state.ts": "frontend",
    "web/index.ts": "frontend",
    "ui/theme.ts": "frontend",
    "src/App.jsx": "frontend",
    "src/App.vue": "frontend",
    "src/App.svelte": "frontend",
    "src/styles.scss": "frontend",
    "index.html": "frontend",
    "backend/scripts/run.ts": "scripts",
    "frontend/tools/build.js": "scripts",
    "bin/start": "scripts",
    "tasks/deploy.ts": "scripts",
    "backend/deploy.sh": "scripts",
    "DEPLOY.PS1": "scripts",
    "backend/src/types/model.ts": "types",
    "frontend/typings/global.d.ts": "types",
    "server/interfaces/request.ts": "types",
    "frontend/src/types.ts": "types",
    "src/model.types.ts": "types",
    "src/globals.d.ts": "types",
    "BACKEND\\Scripts\\RUN.TS": "scripts",
    "src/backendish/typesafe.ts": "other",
    "src/scripts.ts": "other",
    "package.json": "other",
    "unknown": "other",
    "toString": "other",
  } as const;
  for (const [path, expected] of Object.entries(examples)) {
    assert.equal(classifyImplementation(path), expected, path);
  }
  assert.deepEqual(IMPLEMENTATION_GROUP_ORDER, ["backend", "frontend", "scripts", "types", "other"]);
  assert.equal(IMPLEMENTATION_GROUP_LABELS.backend, "Backend / API");
  assert.equal(isImplementationGroup("types"), true);
  assert.equal(isImplementationGroup("implementation"), false);
  assert.equal(isImplementationGroup(undefined), false);
  assert.equal(classifyImplementation("backend/app.ts", { "backend/app.ts": "frontend" }), "frontend");
  assert.equal(classifyImplementation("backend/app.ts", { "BACKEND/app.ts": "frontend" }), "backend");
  assert.equal(classifyImplementation("frontend/app.ts", { "backend/app.ts": "scripts" }), "frontend");
  assert.equal(classifyImplementation("backend/app.ts", { "backend/app.ts": "invalid" } as never), "backend");
  // Subgroups do not change the main category precedence.
  assert.equal(classifyFile("backend/tests/model.ts"), "tests");
  assert.equal(classifyFile("backend/schema.sql"), "migrations");
  assert.equal(classifyFile("frontend/README.md"), "documentation");
});

test("backend modules use API version and real directories without treating filenames as modules", () => {
  const examples = {
    "backend/src/api/v1/commission/sync.ts": "api/v1/commission",
    "backend/src/api/v1/sync.ts": "api/v1",
    "backend/src/api/v2/commission/sync.ts": "api/v2/commission",
    "backend/src/api/commission/sync.ts": "api/commission",
    "backend/src/api/sync.ts": "api",
    "src/api/v10/reservations/detail/index.ts": "api/v10/reservations",
    "BACKEND\\SRC\\API\\V1\\Commission\\sync.ts": "api/v1/commission",
    "backend/src/db/schemas/foo.ts": "db",
    "backend/src/feature/subfolder/file.ts": "feature",
    "server/src/services/reservations.ts": "services",
    "backend/config.ts": "",
    "backend/src/config.ts": "",
    "config.ts": "",
    "src/api.ts": "",
    "backend/src/apiculture/config.ts": "apiculture",
  };
  for (const [path, expected] of Object.entries(examples)) {
    assert.equal(getBackendModule(path), expected, path);
  }
});

test("frontend modules skip route containers, Next groups, and dynamic route segments", () => {
  const examples = {
    "frontend/src/app/dashboard/reservations/components/table.tsx": "reservations",
    "frontend/src/app/dashboard/invoices/page.tsx": "invoices",
    "frontend/src/app/(private)/dashboard/settings/page.tsx": "settings",
    "frontend/src/app/dashboard/reports/[id]/page.tsx": "reports",
    "frontend/src/components/dashboard/charts/Chart.tsx": "components",
    "frontend/src/hooks/useReservations.ts": "hooks",
    "frontend/src/fetchers/reservations.ts": "fetchers",
    "frontend/src/i18n/locales/es.ts": "i18n",
    "frontend/src/styles/main.css": "styles",
    "client/src/pages/invoices/[id]/index.tsx": "invoices",
    "web/src/routes/(private)/dashboard/reports/index.tsx": "reports",
    "ui/src/features/reservations/Overview.tsx": "reservations",
    "FRONTEND\\SRC\\MODULES\\Settings\\Form.tsx": "settings",
    "frontend/src/config.ts": "",
    "frontend/App.tsx": "",
    "src/App.tsx": "",
    "App.tsx": "",
    "frontend/src/app/(private)/dashboard/[id]/page.tsx": "",
    "frontend/src/pages/[[...slug]]/index.tsx": "",
  };
  for (const [path, expected] of Object.entries(examples)) {
    assert.equal(getFrontendModule(path), expected, path);
  }
  assert.equal(classifyImplementation("frontend/src/scripts/run.tsx"), "scripts");
  assert.equal(classifyImplementation("frontend/src/types/reservation.ts"), "types");
  assert.equal(classifyFile("frontend/src/app/reservations/page.test.tsx"), "tests");
});

test("monorepo packages retain their names and override inner module directories", () => {
  const examples = {
    "packages/mira-api/src/api/v1/commission/sync.ts": "packages/mira-api",
    "packages/mira-api/src/db/schema.ts": "packages/mira-api",
    "packages/mira-widgets/src/components/button.tsx": "packages/mira-widgets",
    "packages/mira-widgets/src/modules/reservations/page.tsx": "packages/mira-widgets",
    "packages/mira-editor/src/components/Editor.ts": "packages/mira-editor",
    "apps/one/packages/mira-api/config.ts": "apps/one/packages/mira-api",
    "apps/two/packages/mira-api/config.ts": "apps/two/packages/mira-api",
    "Apps\\One\\Packages\\@Scope\\Mira-Widgets\\src\\index.ts": "Apps/One/Packages/@Scope/Mira-Widgets",
    "packages/@scope/mira-editor/src/editor.ts": "packages/@scope/mira-editor",
    "packages/file.ts": "",
    "packages/@scope/file.ts": "",
    "src/packages.ts": "",
    "packagestest/mira-api/config.ts": "",
  };
  for (const [path, expected] of Object.entries(examples)) {
    assert.equal(getPackageModule(path), expected, path);
    if (expected) {
      assert.equal(getBackendModule(path), expected, path);
      assert.equal(getFrontendModule(path), expected, path);
    }
  }
  assert.equal(classifyImplementation("packages/mira-api/config.json"), "backend");
  assert.equal(classifyImplementation("packages/mira-widgets/src/data.ts"), "frontend");
  assert.equal(classifyImplementation("packages/mira-editor/package.json"), "frontend");
  assert.equal(classifyImplementation("packages/@scope/mira-server/index.js"), "backend");
  assert.equal(classifyImplementation("packages/mira-capi/config.ts"), "other");
  assert.equal(classifyImplementation("packages/mira-apiculture/config.ts"), "other");
  assert.equal(classifyImplementation("packages/shared/config.ts"), "other");
  assert.equal(classifyImplementation("packages/mira-widgets/src/api/router.ts"), "backend");
  assert.equal(classifyImplementation("packages/mira-api/scripts/build.ts"), "scripts");
  assert.equal(classifyImplementation("packages/mira-widgets/src/types/button.ts"), "types");
  assert.equal(classifyImplementation("packages/mira-api/config.ts", { "packages/mira-api/config.ts": "frontend" }), "frontend");
  assert.equal(classifyFile("packages/mira-api/src/api/sync.test.ts"), "tests");
  assert.equal(classifyFile("packages/mira-widgets/docs/usage.md"), "documentation");
  assert.equal(classifyFile("packages/mira-api/src/db/schema.sql"), "migrations");
});
