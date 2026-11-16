import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import type { VcsDriverKind, VcsError, VcsRepositoryIdentity } from "@t3tools/contracts";
import { VcsUnsupportedOperationError } from "@t3tools/contracts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import * as VcsDriver from "./VcsDriver.ts";

const DETECTION_CACHE_CAPACITY = 2_048;
// Detection costs three git processes per cwd; cached hits still stat disk, so TTL bounds only undetectable changes.
const DETECTION_CACHE_TTL = Duration.minutes(5);
const NEGATIVE_DETECTION_CACHE_TTL = Duration.minutes(1);

export interface VcsDriverResolveInput {
  readonly cwd: string;
  readonly requestedKind?: VcsDriverKind | "auto";
}

export interface VcsDriverHandle {
  readonly kind: VcsDriverKind;
  readonly repository: VcsRepositoryIdentity;
  readonly driver: VcsDriver.VcsDriver["Service"];
}

export class VcsDriverRegistry extends Context.Service<
  VcsDriverRegistry,
  {
    readonly get: (kind: VcsDriverKind) => Effect.Effect<VcsDriver.VcsDriver["Service"], VcsError>;
    readonly detect: (
      input: VcsDriverResolveInput,
    ) => Effect.Effect<VcsDriverHandle | null, VcsError>;
    readonly detectOrFail: (
      input: VcsDriverResolveInput,
    ) => Effect.Effect<VcsDriverHandle | null, VcsError>;
    readonly resolve: (input: VcsDriverResolveInput) => Effect.Effect<VcsDriverHandle, VcsError>;
  }
>()("t3/vcs/VcsDriverRegistry") {}

function detectionCacheKey(input: {
  readonly cwd: string;
  readonly requestedKind: VcsDriverKind | "auto";
}): string {
  return `${input.requestedKind}\0${input.cwd}`;
}

function parseDetectionCacheKey(key: string): {
  readonly cwd: string;
  readonly requestedKind: VcsDriverKind | "auto";
} {
  const separatorIndex = key.indexOf("\0");
  return {
    requestedKind: key.slice(0, separatorIndex) as VcsDriverKind | "auto",
    cwd: key.slice(separatorIndex + 1),
  };
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectConfig = yield* VcsProjectConfig.VcsProjectConfig;
  const git = yield* GitVcsDriver.makeVcsDriver;
  const drivers: Partial<Record<VcsDriverKind, VcsDriver.VcsDriver["Service"]>> = {
    git,
  };

  const get: VcsDriverRegistry["Service"]["get"] = (kind) => {
    const driver = drivers[kind];
    if (!driver) {
      return Effect.fail(
        new VcsUnsupportedOperationError({
          operation: "VcsDriverRegistry.get",
          kind,
          detail: `No ${kind} VCS driver is registered.`,
        }),
      );
    }
    return Effect.succeed(driver);
  };

  const detectWithDriver = Effect.fn("VcsDriverRegistry.detectWithDriver")(function* (
    kind: VcsDriverKind,
    driver: VcsDriver.VcsDriver["Service"],
    cwd: string,
  ) {
    const repository = yield* driver.detectRepository(cwd);
    if (!repository) {
      return null;
    }
    return {
      kind,
      repository,
      driver,
    } satisfies VcsDriverHandle;
  });

  const detectResolvedKind = Effect.fn("VcsDriverRegistry.detectResolvedKind")(function* (input: {
    readonly cwd: string;
    readonly requestedKind: VcsDriverKind | "auto";
  }) {
    const requestedKind = input.requestedKind;

    if (requestedKind !== "auto" && requestedKind !== "unknown") {
      const driver = yield* get(requestedKind);
      return yield* detectWithDriver(requestedKind, driver, input.cwd);
    }

    return yield* detectWithDriver("git", git, input.cwd);
  });

  // Symlinks can put cwd outside root; then inspect cwd alone.
  const foldersBelowRoot = (cwd: string, rootPath: string) => {
    const relative = path.relative(path.resolve(rootPath), path.resolve(cwd));
    if (relative.startsWith("..") || path.isAbsolute(relative)) return [cwd];
    return Array.from({ length: relative.split(path.sep).length }, (_, levelsUp) =>
      path.resolve(cwd, ...Array<string>(levelsUp).fill("..")),
    );
  };

  const foldersToRoot = (cwd: string) => {
    const root = path.parse(path.resolve(cwd)).root;
    return [...foldersBelowRoot(cwd, root), root];
  };

  const readDiskState = Effect.fn("VcsDriverRegistry.readDiskState")(
    function* (cwd: string, repository: VcsRepositoryIdentity | null) {
      const realCwd = yield* fileSystem.realPath(cwd);
      const folders =
        repository === null
          ? [...new Set([...foldersToRoot(cwd), ...foldersToRoot(realCwd)])]
          : foldersBelowRoot(cwd, repository.rootPath);
      const disk = yield* Effect.all({
        gitEntries: Effect.forEach(folders, (folder) =>
          fileSystem.exists(path.join(folder, ".git")),
        ),
        repositoryOnDisk: Effect.forEach(
          repository === null || repository.metadataPath === null
            ? [cwd]
            : [cwd, path.resolve(cwd, repository.metadataPath)],
          (target) => fileSystem.exists(target),
        ).pipe(Effect.map((results) => results.every(Boolean))),
      });
      return { ...disk, realCwd };
    },
    Effect.orElseSucceed(() => null),
  );

  const detectionCache = yield* Cache.makeWith<
    string,
    {
      readonly handle: VcsDriverHandle | null;
      readonly gitEntries: ReadonlyArray<boolean>;
      readonly realCwd: string | null;
    },
    VcsError
  >(
    (key) =>
      Effect.gen(function* () {
        const input = parseDetectionCacheKey(key);
        const handle = yield* detectResolvedKind(input);
        const disk = yield* readDiskState(input.cwd, handle?.repository ?? null);
        return { handle, gitEntries: disk?.gitEntries ?? [], realCwd: disk?.realCwd ?? null };
      }),
    {
      capacity: DETECTION_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (detected) =>
          detected.realCwd === null ||
          (detected.handle === null && detected.gitEntries.some(Boolean))
            ? Duration.zero
            : detected.handle === null
              ? NEGATIVE_DETECTION_CACHE_TTL
              : DETECTION_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );

  const detectOrFail: VcsDriverRegistry["Service"]["detectOrFail"] = Effect.fn(
    "VcsDriverRegistry.detectOrFail",
  )(function* (input) {
    const requestedKind = yield* projectConfig.resolveKind(input);
    const key = detectionCacheKey({ cwd: input.cwd, requestedKind });
    const cached = yield* Cache.get(detectionCache, key);
    const disk = yield* readDiskState(input.cwd, cached.handle?.repository ?? null);
    if (
      disk?.repositoryOnDisk &&
      disk.realCwd === cached.realCwd &&
      disk.gitEntries.length === cached.gitEntries.length &&
      disk.gitEntries.every((exists, index) => exists === cached.gitEntries[index])
    ) {
      return cached.handle;
    }
    yield* Cache.invalidate(detectionCache, key);
    return (yield* Cache.get(detectionCache, key)).handle;
  });

  const detect: VcsDriverRegistry["Service"]["detect"] = Effect.fn("VcsDriverRegistry.detect")(
    (input) =>
      detectOrFail(input).pipe(
        Effect.catchTags({
          VcsProcessExitError: (error) =>
            error.operation === GitVcsDriver.WORK_TREE_PROBE_OPERATION
              ? Effect.succeed(null)
              : Effect.fail(error),
        }),
      ),
  );

  const resolve: VcsDriverRegistry["Service"]["resolve"] = Effect.fn("VcsDriverRegistry.resolve")(
    function* (input) {
      const detected = yield* detect(input);
      if (detected) {
        return detected;
      }

      const requestedKind = input.requestedKind ?? "auto";
      return yield* new VcsUnsupportedOperationError({
        operation: "VcsDriverRegistry.resolve",
        kind: requestedKind === "auto" ? "unknown" : requestedKind,
        detail:
          requestedKind === "auto"
            ? `No supported VCS repository was detected at ${input.cwd}.`
            : `No ${requestedKind} repository was detected at ${input.cwd}.`,
      });
    },
  );

  return VcsDriverRegistry.of({
    get,
    detect,
    detectOrFail,
    resolve,
  });
});

export const layer = Layer.effect(VcsDriverRegistry, make).pipe(
  Layer.provide(VcsProjectConfig.layer),
);
