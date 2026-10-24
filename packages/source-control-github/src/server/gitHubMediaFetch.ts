import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import { GITHUB_CREDENTIALED_MEDIA_HOSTS } from "../shared/gitHubMedia.ts";

import * as GitHubCredentials from "./GitHubCredentials.ts";

/** Redirected object stores authorize with their own signature, never a GitHub bearer. */
const isCredentialedHost = (url: string) => {
  try {
    return GITHUB_CREDENTIALED_MEDIA_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
};

const repositoryOf = (source: string) => {
  const url = new URL(source);
  const parts = url.pathname.split("/");
  if (url.hostname.toLowerCase() === "media.githubusercontent.com") {
    if (parts[1] !== "media") return null;
    parts.splice(1, 1);
  }
  const repository = `${parts[1]}/${parts[2]}`;
  return isCredentialedHost(source) &&
    parts.length > 3 &&
    parts[1] !== "user-attachments" &&
    GitHubCredentials.normalizeCredentialRepository(repository) !== null
    ? repository
    : null;
};

const MAX_REDIRECTS = 3;
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };

export const make = Effect.gen(function* () {
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const enabled = (yield* HostProcess.Environment).T3CODE_GITHUB_USE_GIT_CREDENTIALS === "1";

  return Effect.fn("GitHubMediaFetch.fetchMedia")(function* (request: SourceControlMediaRequest) {
    // Read on every fetch, so media loads as soon as the user signs in. Attachments without
    // a repository keep the host default; raw and LFS URLs keep their exact helper spelling.
    const repository = repositoryOf(request.url);
    const credential = yield* isCredentialedHost(request.url)
      ? credentials.get("github.com", repository ?? undefined).pipe(
          Effect.catchIf(
            (error) => error._tag !== "GitHubGitCredentialError",
            () => Effect.succeed(null),
          ),
          // The generic media driver exposes HTTP failures; retain the helper failure as cause
          // and fail before HTTP, rather than treating a broken helper as a credential miss.
          Effect.mapError(
            (cause) =>
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request: HttpClientRequest.get(request.url),
                  description: "GitHub media credential lookup failed.",
                  cause,
                }),
              }),
          ),
        )
      : Effect.succeed(null);
    // Redirect scope follows the requested repository even after a helper miss. Invalidation
    // still follows the selected credential's actual provenance, which may be host-wide.
    const operationRepository =
      enabled && repository !== null
        ? GitHubCredentials.normalizeCredentialRepository(repository)!
        : credential?.repository;
    let target = request.url;
    for (let hop = 0; ; hop += 1) {
      const authorization =
        credential !== null &&
        isCredentialedHost(target) &&
        (operationRepository === undefined ||
          GitHubCredentials.normalizeCredentialRepository(repositoryOf(target) ?? "") ===
            operationRepository)
          ? `Bearer ${Redacted.value(credential.token)}`
          : null;
      const response: HttpClientResponse.HttpClientResponse = yield* httpClient
        .execute(
          HttpClientRequest.get(target).pipe(
            HttpClientRequest.setHeaders({
              ...request.headers,
              // The bytes are streamed straight through, so never let an encoding layer in.
              "accept-encoding": "identity",
              ...(authorization === null ? {} : { authorization }),
            }),
          ),
        )
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT));
      const location = response.headers.location;
      if (response.status < 300 || response.status >= 400) {
        if (
          authorization !== null &&
          operationRepository !== undefined &&
          (response.status === 401 || response.status === 403)
        ) {
          yield* credentials.invalidate("github.com", credential?.repository);
        }
        return response;
      }
      if (!location || hop >= MAX_REDIRECTS) return null;
      const next = new URL(location, target);
      if (next.protocol !== "https:") return null;
      target = next.toString();
    }
  });
});
