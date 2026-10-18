import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import { githubMediaResponse } from "./GitHubMediaFetch.ts";

const asset = (url: string) => ({
  url,
  cwd: "/untrusted-checkout",
  expiresAt: Number.MAX_SAFE_INTEGER,
});

describe("repository GitHub media credentials", () => {
  it.effect.each([true, false])(
    "keeps legacy fallback redirect behavior only with opt-in disabled: %s",
    (enabled) => {
      const authorizations: Array<string | undefined> = [];
      return Effect.gen(function* () {
        yield* githubMediaResponse(
          asset("https://raw.githubusercontent.com/OwnerA/Repo/main/image.png"),
          {},
        );
        expect(authorizations).toEqual([
          "Bearer fake-fallback",
          enabled ? undefined : "Bearer fake-fallback",
        ]);
      }).pipe(
        Effect.provide(
          Layer.mock(GitHubCredentials.GitHubCredentials)({
            get: (host, repository) => {
              expect(repository).toBe("OwnerA/Repo");
              // A repository helper miss returns the legacy credential without helper provenance.
              return Effect.succeed({
                host,
                source: "settings",
                fingerprint: "default",
                token: Redacted.make("fake-fallback"),
              });
            },
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            authorizations.push(request.headers.authorization);
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  null,
                  authorizations.length === 1
                    ? {
                        status: 302,
                        headers: {
                          location: "https://raw.githubusercontent.com/OwnerB/Repo/main/image.png",
                        },
                      }
                    : { status: 200, headers: { "content-type": "image/png" } },
                ),
              ),
            );
          }),
        ),
        Effect.provideService(HostProcess.Environment, {
          T3CODE_GITHUB_USE_GIT_CREDENTIALS: enabled ? "1" : "0",
        }),
        Effect.scoped,
      );
    },
  );

  it.effect.each([401, 403])(
    "invalidates the host cache after opted-in fallback HTTP %s",
    (status) => {
      const invalidations: Array<readonly [string, string | undefined]> = [];
      let requests = 0;
      return Effect.gen(function* () {
        expect(
          (yield* githubMediaResponse(
            asset("https://raw.githubusercontent.com/OwnerA/Repo/main/image.png"),
            {},
          )).status,
        ).toBe(status);
        expect(invalidations).toEqual([["github.com", undefined]]);
        expect(requests).toBe(1);
      }).pipe(
        Effect.provide(
          Layer.mock(GitHubCredentials.GitHubCredentials)({
            get: (host) =>
              Effect.succeed({
                host,
                source: "gh",
                fingerprint: "default",
                token: Redacted.make("fake-fallback"),
              }),
            invalidate: (host, repository) =>
              Effect.sync(() => {
                invalidations.push([host, repository]);
              }),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            requests++;
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(null, { status })),
            );
          }),
        ),
        Effect.provideService(HostProcess.Environment, { T3CODE_GITHUB_USE_GIT_CREDENTIALS: "1" }),
        Effect.scoped,
      );
    },
  );

  it.effect(
    "uses raw URL repository context and strips a scoped token across repository redirects",
    () => {
      const scopes: Array<string | undefined> = [];
      const authorizations: Array<string | undefined> = [];
      return Effect.gen(function* () {
        const response = yield* githubMediaResponse(
          asset("https://raw.githubusercontent.com/OwnerA/Repo/main/image.png"),
          {},
        );
        expect(response.status).toBe(200);
        expect(scopes).toEqual(["OwnerA/Repo"]);
        expect(authorizations).toEqual(["Bearer fake-owner-a", undefined]);
      }).pipe(
        Effect.provide(
          Layer.mock(GitHubCredentials.GitHubCredentials)({
            get: (host, repository) => {
              scopes.push(repository);
              return Effect.succeed({
                host,
                repository: "ownera/repo",
                source: "git",
                fingerprint: "fake-a",
                token: Redacted.make("fake-owner-a"),
              });
            },
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            authorizations.push(request.headers.authorization);
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  null,
                  authorizations.length === 1
                    ? {
                        status: 302,
                        headers: {
                          location: "https://raw.githubusercontent.com/OwnerB/Repo/main/image.png",
                        },
                      }
                    : { status: 200, headers: { "content-type": "image/png" } },
                ),
              ),
            );
          }),
        ),
        Effect.scoped,
      );
    },
  );

  it.effect("keeps attachments without repository context on the host default", () => {
    const scopes: Array<string | undefined> = [];
    return Effect.gen(function* () {
      yield* githubMediaResponse(asset("https://github.com/user-attachments/assets/fake-id"), {});
      expect(scopes).toEqual([undefined]);
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubCredentials.GitHubCredentials)({
          get: (host, repository) => {
            scopes.push(repository);
            return Effect.succeed({
              host,
              source: "settings",
              fingerprint: "default",
              token: Redacted.make("fake-default"),
            });
          },
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))),
        ),
      ),
      Effect.scoped,
    );
  });

  it.effect("reports helper failures without a host fallback or HTTP request", () =>
    Effect.gen(function* () {
      const error = yield* githubMediaResponse(
        asset("https://raw.githubusercontent.com/OwnerA/Repo/main/image.png"),
        {},
      ).pipe(Effect.flip);
      expect(error._tag).toBe("GitHubGitCredentialError");
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubCredentials.GitHubCredentials)({
          get: () =>
            Effect.fail(
              new GitHubCredentials.GitHubGitCredentialError({
                host: "github.com",
                reason: "process",
              }),
            ),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Must not fetch after helper failure")),
      ),
      Effect.scoped,
    ),
  );
});
