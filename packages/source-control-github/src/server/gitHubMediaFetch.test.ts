import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubMediaFetch from "./gitHubMediaFetch.ts";

const asset = (url: string) => ({ url, headers: {} });

describe("repository GitHub media credentials", () => {
  it.effect.each([
    "https://example.test/image.png",
    "https://github.com/user-attachments/assets/fake-id",
    "https://raw.githubusercontent.com/OwnerB/Repo/main/image.png",
  ])("strips bearer on redirect to %s without invalidating an unused credential", (target) => {
    const authorizations: Array<string | undefined> = [];
    let invalidations = 0;
    return Effect.gen(function* () {
      const fetchMedia = yield* GitHubMediaFetch.make;
      const response = yield* fetchMedia(
        asset("https://raw.githubusercontent.com/OwnerA/Repo/main/image.png"),
      );
      expect(response?.status).toBe(403);
      expect(authorizations).toEqual(["Bearer synthetic-a", undefined]);
      expect(invalidations).toBe(0);
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubCredentials.GitHubCredentials)({
          get: (host) =>
            Effect.succeed({
              host,
              repository: "ownera/repo",
              source: "git",
              fingerprint: "synthetic",
              token: Redacted.make("synthetic-a"),
            }),
          invalidate: () =>
            Effect.sync(() => {
              invalidations++;
            }),
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
                  ? { status: 302, headers: { location: target } }
                  : { status: 403 },
              ),
            ),
          );
        }),
      ),
      Effect.provideService(HostProcess.Environment, { T3CODE_GITHUB_USE_GIT_CREDENTIALS: "1" }),
      Effect.scoped,
    );
  });

  it.effect.each(["http://example.test/file.png", "https://example.test/file.png"])(
    "bounds redirects and refuses downgrade: %s",
    (target) => {
      let requests = 0;
      return Effect.gen(function* () {
        const fetchMedia = yield* GitHubMediaFetch.make;
        const response = yield* fetchMedia(
          asset("https://github.com/user-attachments/assets/fake"),
        );
        expect(response).toBeNull();
        expect(requests).toBe(target.startsWith("http:") ? 1 : 4);
      }).pipe(
        Effect.provide(
          Layer.mock(GitHubCredentials.GitHubCredentials)({
            get: () =>
              Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host: "github.com" })),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            requests++;
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(null, { status: 302, headers: { location: target } }),
              ),
            );
          }),
        ),
        Effect.scoped,
      );
    },
  );

  it.effect.each([
    { fallback: false, enabled: true, unsupportedPrefix: false },
    { fallback: true, enabled: true, unsupportedPrefix: false },
    { fallback: true, enabled: false, unsupportedPrefix: false },
    { fallback: true, enabled: true, unsupportedPrefix: true },
  ])(
    "uses LFS repository context through redirects: fallback $fallback, opt-in $enabled, unsupported prefix $unsupportedPrefix",
    ({ fallback, enabled, unsupportedPrefix }) => {
      const scopes: Array<string | undefined> = [];
      const authorizations: Array<string | undefined> = [];
      const redirects = [
        "https://raw.githubusercontent.com/OwnerA/Repo/main/image.png",
        "https://media.githubusercontent.com/media/ownera/repo/main/image.png",
        unsupportedPrefix
          ? "https://media.githubusercontent.com/OwnerA/Repo/main/image.png"
          : "https://media.githubusercontent.com/media/OwnerB/Repo/main/image.png",
      ];
      return Effect.gen(function* () {
        const fetchMedia = yield* GitHubMediaFetch.make;
        const response = yield* fetchMedia(
          asset("https://media.githubusercontent.com/media/OwnerA/Repo/main/image.png"),
        );
        expect(response?.status).toBe(200);
        expect(scopes).toEqual(["OwnerA/Repo"]);
        expect(authorizations).toEqual([
          "Bearer fake-owner-a",
          "Bearer fake-owner-a",
          "Bearer fake-owner-a",
          enabled ? undefined : "Bearer fake-owner-a",
        ]);
      }).pipe(
        Effect.provide(
          Layer.mock(GitHubCredentials.GitHubCredentials)({
            get: (host, repository) => {
              scopes.push(repository);
              return Effect.succeed({
                host,
                ...(fallback ? {} : { repository: "ownera/repo" }),
                source: fallback ? "settings" : "git",
                fingerprint: "fake-a",
                token: Redacted.make("fake-owner-a"),
              });
            },
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const location = redirects[authorizations.length];
            authorizations.push(request.headers.authorization);
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(null, {
                  status: location === undefined ? 200 : 302,
                  headers: location === undefined ? { "content-type": "image/png" } : { location },
                }),
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

  it.effect.each([
    { path: "raw.githubusercontent.com/media/Repo/main/image.png", repository: "media/Repo" },
    { path: "media.githubusercontent.com/OwnerA/Repo/main/image.png", repository: undefined },
    { path: "media.githubusercontent.com/Media/OwnerA/Repo/main/image.png", repository: undefined },
    { path: "media.githubusercontent.com/media/OwnerA/Repo", repository: undefined },
    { path: "media.githubusercontent.com/media//Repo/main/image.png", repository: undefined },
    {
      path: "media.githubusercontent.com/media/Owner%2FA/Repo/main/image.png",
      repository: undefined,
    },
    {
      path: "media.githubusercontent.com/media/OwnerA/-Repo/main/image.png",
      repository: undefined,
    },
  ])("requires the LFS prefix only on its own host: $path", ({ path, repository }) =>
    Effect.gen(function* () {
      const fetchMedia = yield* GitHubMediaFetch.make;
      yield* fetchMedia(asset(`https://${path}`));
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubCredentials.GitHubCredentials)({
          get: (host, selected) => {
            expect(selected).toBe(repository);
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
        HttpClient.make((request) => {
          expect(request.headers.authorization).toBe("Bearer fake-default");
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })),
          );
        }),
      ),
      Effect.provideService(HostProcess.Environment, { T3CODE_GITHUB_USE_GIT_CREDENTIALS: "1" }),
      Effect.scoped,
    ),
  );

  it.effect.each([true, false])(
    "keeps legacy fallback redirect behavior only with opt-in disabled: %s",
    (enabled) => {
      const authorizations: Array<string | undefined> = [];
      return Effect.gen(function* () {
        const fetchMedia = yield* GitHubMediaFetch.make;
        yield* fetchMedia(asset("https://raw.githubusercontent.com/OwnerA/Repo/main/image.png"));
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
        const fetchMedia = yield* GitHubMediaFetch.make;
        expect(
          (yield* fetchMedia(asset("https://raw.githubusercontent.com/OwnerA/Repo/main/image.png")))
            ?.status,
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
        const fetchMedia = yield* GitHubMediaFetch.make;
        const response = yield* fetchMedia(
          asset("https://raw.githubusercontent.com/OwnerA/Repo/main/image.png"),
        );
        expect(response?.status).toBe(200);
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
      const fetchMedia = yield* GitHubMediaFetch.make;
      yield* fetchMedia(asset("https://github.com/user-attachments/assets/fake-id"));
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
      const fetchMedia = yield* GitHubMediaFetch.make;
      const error = yield* fetchMedia(
        asset("https://raw.githubusercontent.com/OwnerA/Repo/main/image.png"),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("HttpClientError");
      expect(error.reason._tag).toBe("TransportError");
      if (error.reason._tag === "TransportError")
        expect(error.reason.cause).toBeInstanceOf(GitHubCredentials.GitHubGitCredentialError);
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

describe("GitHubMediaFetch", () => {
  it.effect("loads private media immediately after login with the GitHub credential", () => {
    let lookups = 0;
    const authorizations: Array<string | undefined> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* GitHubMediaFetch.make;
      const request = {
        url: "https://raw.githubusercontent.com/owner/repo/main/shot.png",
        headers: {},
      };
      expect((yield* fetchMedia(request))?.status).toBe(404);
      expect((yield* fetchMedia(request))?.status).toBe(200);
      expect((yield* fetchMedia(request))?.status).toBe(200);
      expect(lookups).toBe(3);
      expect(authorizations).toEqual([undefined, "Bearer signed-in", "Bearer signed-in"]);
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubCredentials.GitHubCredentials)({
          get: (host) =>
            ++lookups === 1
              ? Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host }))
              : Effect.succeed({
                  host,
                  token: Redacted.make("signed-in"),
                  source: "gh" as const,
                  fingerprint: "fingerprint",
                }),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          authorizations.push(request.headers.authorization);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, {
                status: request.headers.authorization ? 200 : 404,
                headers: { "content-type": "image/png" },
              }),
            ),
          );
        }),
      ),
      Effect.scoped,
    );
  });

  it.effect("keeps the credential off the object store a redirect hands the media to", () => {
    const authorizations: Array<[string, string | undefined]> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* GitHubMediaFetch.make;
      const response = yield* fetchMedia({
        url: "https://github.com/user-attachments/assets/1a1842fb",
        headers: { range: "bytes=0-1" },
      });
      expect(response?.status).toBe(200);
      expect(authorizations).toEqual([
        ["github.com", "Bearer signed-in"],
        ["objects.example.com", undefined],
      ]);
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubCredentials.GitHubCredentials)({
          get: (host) =>
            Effect.succeed({
              host,
              token: Redacted.make("signed-in"),
              source: "gh" as const,
              fingerprint: "fingerprint",
            }),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const url = new URL(request.url);
          authorizations.push([url.hostname, request.headers.authorization]);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              url.hostname === "github.com"
                ? new Response(null, {
                    status: 302,
                    headers: { location: "https://objects.example.com/signed" },
                  })
                : new Response(null, { status: 200 }),
            ),
          );
        }),
      ),
      Effect.scoped,
    );
  });
});
