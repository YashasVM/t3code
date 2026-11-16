import { describe, expect, it } from "vite-plus/test";
import { RunId, type OrchestrationV2Run } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  getThreadErrorBannerMessage,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
  threadErrorBannerRunId,
} from "./ThreadErrorBanner";

describe("getThreadErrorBannerMessage", () => {
  it("extracts a readable nested message without trimming its whitespace", () => {
    const message =
      "  This model is not supported with a ChatGPT account.\nChoose another model.  ";
    const error = ` \n${JSON.stringify({ error: { message, code: "unsupported_model" } })}\t `;

    expect(getThreadErrorBannerMessage(error)).toBe(message);
  });

  it("keeps the diagnostics when the nested message is blank", () => {
    const error = JSON.stringify({ error: { message: " \n\t ", code: "unsupported_model" } });

    expect(getThreadErrorBannerMessage(error)).toBe(error);
  });
});

describe("ThreadErrorBanner", () => {
  it("keeps a dismissed runtime error tied to its failed run while another starts", () => {
    const failed = {
      id: RunId.make("failed"),
      status: "failed",
      ordinal: 1,
      completedAt: DateTime.makeUnsafe("2026-11-16T01:00:00Z"),
    } as const;
    const starting = {
      id: RunId.make("starting"),
      status: "starting",
      ordinal: 2,
      completedAt: null,
    } as const;
    const key = (
      runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status" | "ordinal" | "completedAt">>,
      localError: string | null = null,
    ) =>
      getThreadErrorBannerKey(
        "env:retained-error",
        "Same diagnostics",
        threadErrorBannerRunId(runs, localError),
      );
    const dismissed = key([failed]);
    dismissThreadErrorBannerForSession(dismissed);
    expect(key([failed, starting])).toBe(dismissed);
    expect(isThreadErrorBannerDismissedForSession(key([failed, starting]))).toBe(true);
    const failedAgain = {
      ...starting,
      status: "failed" as const,
      completedAt: DateTime.makeUnsafe("2026-11-16T01:01:00Z"),
    };
    expect(isThreadErrorBannerDismissedForSession(key([failed, failedAgain]))).toBe(false);
    const completed = { ...failedAgain, status: "completed" as const };
    expect(threadErrorBannerRunId([failed, completed], null)).toBeNull();
  });

  it("keeps local send failures independent of unrelated server runs", () => {
    const failed = {
      id: RunId.make("local-error-run"),
      status: "failed",
      ordinal: 1,
      completedAt: DateTime.makeUnsafe("2026-11-16T01:00:00Z"),
    } as const;
    expect(threadErrorBannerRunId([failed], "Could not send")).toBeNull();
    expect(threadErrorBannerRunId([], null)).toBeNull();
  });
  it("shows a later failed run with identical diagnostics while keeping the first dismissed", () => {
    const error = "Workspace does not exist";
    const first = getThreadErrorBannerKey("env:repeated-error", error, "run-one");
    dismissThreadErrorBannerForSession(first);
    expect(isThreadErrorBannerDismissedForSession(first)).toBe(true);
    const second = getThreadErrorBannerKey("env:repeated-error", error, "run-two");
    expect(isThreadErrorBannerDismissedForSession(second)).toBe(false);
  });

  it("reappears for different diagnostics with the same headline on the same thread", () => {
    const firstError = JSON.stringify({ error: { message: "Turn failed", code: "first" } });
    const secondError = JSON.stringify({ error: { message: "Turn failed", code: "second" } });
    const dismissedKey = getThreadErrorBannerKey("env:thread-b", firstError);
    dismissThreadErrorBannerForSession(dismissedKey);
    const newErrorKey = getThreadErrorBannerKey("env:thread-b", secondError);

    expect(isThreadErrorBannerDismissedForSession(dismissedKey)).toBe(true);
    expect(isThreadErrorBannerDismissedForSession(newErrorKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "env:thread-b",
        secondError,
        isThreadErrorBannerDismissedForSession(newErrorKey),
      ),
    ).toBe(true);
  });
});
