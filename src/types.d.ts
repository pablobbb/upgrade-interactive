// Shapes shared across modules, for the JSDoc annotations in the .js sources.
// Types only: nothing here exists at runtime, and `tsc` checks against it
// without compiling anything (see tsconfig.json). A module pulls these in with
// `/** @import { Vuln } from './types.js' */`.

// ---- Manifests and the lockfile -------------------------------------------
//
// These describe what npm writes. The code still checks every field before
// trusting it, because a hand-edited package.json can hold anything.

export type DependencyField = 'dependencies' | 'devDependencies';
export type DependencyMap = Record<string, string>;

/** An `overrides` value: a pin, or an object of pins nested under a parent key. */
export type OverrideValue = string | OverrideObject;
export interface OverrideObject {
  [key: string]: OverrideValue;
}
/** The `overrides` block of a package.json. */
export type Overrides = OverrideObject;

/** The `workspaces` field: an array of globs, or `{ packages: [...] }`. */
export type WorkspacesField = string[] | { packages?: string[] };

export interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: DependencyMap;
  devDependencies?: DependencyMap;
  optionalDependencies?: DependencyMap;
  peerDependencies?: DependencyMap;
  overrides?: Overrides;
  workspaces?: WorkspacesField;
  'upgrade-interactive'?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One entry of package-lock.json's `packages` map. */
export interface LockPackage {
  version?: string;
  /** A workspace or `file:` link, which has no version of its own. */
  link?: boolean;
  dependencies?: DependencyMap;
  devDependencies?: DependencyMap;
  optionalDependencies?: DependencyMap;
  peerDependencies?: DependencyMap;
  [key: string]: unknown;
}
/** package-lock.json's `packages`, keyed by install path ("" is the root). */
export type LockPackages = Record<string, LockPackage>;

export interface InstalledTree {
  versions: Map<string, Set<string>>;
  packages: LockPackages;
}

// ---- Projects -------------------------------------------------------------

/** One dependency as declared in a single manifest. */
export interface ManifestDescriptor {
  name: string;
  range: string;
  field: DependencyField;
  /** `"<field> <name>"`: one slot, since a name can be in both fields. */
  key: string;
}

export interface Manifest {
  filePath: string;
  json: PackageJson;
  raw: string;
  indent: string;
  trailingNewline: boolean;
  descriptors: ManifestDescriptor[];
}

/** A manifest as loadProject returns it, tagged with its place in the project. */
export interface ProjectManifest extends Manifest {
  /** Display name; null for the root. */
  workspace: string | null;
  relPath: string;
}

export interface WorkspaceInfo {
  dir: string;
  name: string | null;
  /** Always POSIX-separated; "." for the root. */
  relPath: string;
}

/** One upgradable row: a dependency of one manifest in the project. */
export interface Descriptor {
  name: string;
  range: string;
  field: DependencyField;
  workspace: string | null;
  relPath: string;
  /** `"<relPath> <field> <name>"`, unique across the project. */
  id: string;
}

/** What App accepts: single-package callers may omit the workspace fields. */
export type InputDescriptor = Pick<Descriptor, 'name' | 'range' | 'field'> &
  Partial<Pick<Descriptor, 'id' | 'workspace' | 'relPath'>>;

export interface Project {
  root: ProjectManifest;
  manifests: ProjectManifest[];
  descriptors: Descriptor[];
  /** Discovered packages as scoped by the options; null when standalone. */
  workspaces: WorkspaceInfo[] | null;
  /** The real tree regardless of `--no-workspaces`; null when standalone. */
  discovered: WorkspaceInfo[] | null;
}

// ---- Registry and version suggestions -------------------------------------

export interface PackageMeta {
  versions: string[];
  distTags: Record<string, string>;
}

/** An advisory as npm's bulk advisories endpoint returns it. */
export interface Advisory {
  id?: number;
  url?: string | null;
  title?: string;
  severity?: string;
  vulnerable_versions: string;
  patched_versions?: string;
  cves?: string[];
  github_advisory_id?: string;
}

export interface BulkAdvisories {
  /** False when a request failed, so "none found" can't be mistaken for "couldn't check". */
  ok: boolean;
  advisories: Map<string, Advisory[]>;
}

export interface Span {
  text: string;
  color: string | null;
}

export interface Suggestion {
  key: 'current' | 'range' | 'latest';
  /** The range to write; null for Current, or a column with nothing to offer. */
  value: string | null;
  /** Empty when the column has nothing to offer. */
  spans: Span[];
}

/** A loaded row: its descriptor and the Current / Range / Latest columns. */
export interface Entry {
  descriptor: Descriptor;
  suggestions: Suggestion[];
}

// ---- Vulnerabilities ------------------------------------------------------

export type Severity = 'critical' | 'high' | 'moderate' | 'low';

/** Why npm would ignore or reject the scoped pin an instance needs. */
export type PinRefusal =
  | { kind: 'reaches'; copy: string }
  | { kind: 'eoverride'; key: string; name: string; rootSpec: string | null }
  | { kind: 'shadowed'; by: string; proposed?: undefined }
  | { kind: 'shadowed'; by: string; proposed: true; key: string; name: string; version: string };

/** One dependent of a vulnerable package: the edge a scoped pin would fix. */
export interface PinInstance {
  /** Null for the root project (a direct dependency). */
  parentName: string | null;
  parentPath: string;
  parentVersion: string | null;
  declaredRange: string;
  /** Null only when merged copies carry no valid version to take a floor from. */
  installedVersion: string | null;
  vulnerable: boolean;
  /** Safe versions in the declared range and no downgrade, newest last. */
  safeCandidates: string[];
  bestSafeInRange: string | null;
  /** Manifests disagree on the declared range, so no single pin is honest. */
  conflict?: boolean;
  conflictRanges?: string[];
  pinRefusal?: PinRefusal;
}

/** A user's own override that holds a package where no fix lands. */
export interface HeldPin {
  key: string;
  pin: string;
}

export interface Vuln {
  advisories: Advisory[];
  severity: Severity;
  cve: string;
  url: string | null;
  affectedRange: string;
  /** Newest installed version that is still vulnerable. */
  current: string | null;
  firstPatched: string | null;
  safeVersions: string[];
  instances: PinInstance[];
  pinStrategy: 'global' | 'scoped';
  pinConflict: boolean;
  /** Re-resolving every dependent's range would fix it with no override. */
  inRangeFix: boolean;
  /** Null when the user's overrides can't be judged. */
  heldBy: HeldPin[] | null;
}

export interface RemovableOverride {
  pin: string;
  reason: 'dead' | 'redundant';
}

/** One installed edge that an override mandates but the lockfile contradicts. */
export interface UnappliedEdge {
  parentName: string | null;
  parentVersion: string | null;
  path: string;
  installedVersion: string;
}

export interface UnappliedOverride {
  mandates: { name: string; mandated: string; found: UnappliedEdge[] }[];
}

export interface AuditResult {
  offline: boolean;
  vulns: Map<string, Vuln>;
  removableOverrides?: Map<string, RemovableOverride>;
  unappliedOverrides?: Map<string, UnappliedOverride>;
}

// ---- Override specs (what the UI stages and the writer writes) ------------

export interface ScopedPin {
  /** Null pins the root project's own (direct) edge. */
  parentName: string | null;
  /** Absent in the older spec shape, which the writer still accepts. */
  parentVersion?: string | null;
  version: string;
  /** The `overrides` key, when the bare parent name would reach too far. */
  parentSelector?: string;
}

export interface ScopedSpec {
  scoped: ScopedPin[];
}

/** A version string pins every instance; a ScopedSpec pins per dependent. */
export type OverrideSpec = string | ScopedSpec;

/** A staged override, with the row that owns it. */
export interface StagedOverride {
  spec: OverrideSpec;
  originKey: string;
  /** Owning workspace's label; null when staged from the shared section. */
  originLabel: string | null;
}

// ---- Writer results -------------------------------------------------------

export interface AppliedUpgrade {
  name: string;
  field: DependencyField;
  from: string;
  to: string;
}

export interface ProjectAppliedUpgrade extends AppliedUpgrade {
  workspace: string | null;
  relPath: string;
}

export interface WrittenOverride {
  name: string;
  to: string;
  /** The parent key it was nested under; absent for a top-level pin. */
  parent?: string;
}

export interface ApplyResult<A extends AppliedUpgrade = AppliedUpgrade> {
  applied: A[];
  overrides: WrittenOverride[];
  removed: { name: string }[];
  /** Accepted pins that were already in the manifest, so nothing was written. */
  alreadyPresent: WrittenOverride[];
}

// ---- Display rows ---------------------------------------------------------

export interface UnappliedListItem {
  key: string;
  name: string;
  mandated: string;
  installed: string | null;
  parentName?: string | null;
}

export type DisplayRow =
  | { kind: 'loading'; key: string }
  | { kind: 'wsheader'; key: string; relPath: string; workspace: string | null }
  | { kind: 'header'; key: string; title: string }
  | { kind: 'dep'; key: string; descriptor: Descriptor; entry: Entry; vuln: Vuln | null }
  | { kind: 'vuln'; key: string; name: string; vuln: Vuln }
  | { kind: 'override'; key: string; name: string; pin: string; reason: RemovableOverride['reason'] }
  | {
      kind: 'unapplied';
      key: string;
      name: string;
      mandated: string;
      installed: string | null;
      parentName: string | null;
    };

// ---- Tests ----------------------------------------------------------------

/**
 * Every field optional, all the way down. For test fixtures that deliberately
 * carry only the fields the code under test reads.
 */
export type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends Map<infer K, infer V>
    ? Map<K, DeepPartial<V>>
    : T extends object
      ? { [P in keyof T]?: DeepPartial<T[P]> }
      : T;
