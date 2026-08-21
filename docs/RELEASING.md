# Release process

`@oh-story/dsh` is distributed as the same prebuilt tarball through npm and
GitHub Releases. A release is created only from a `v<package-version>` tag.

## One-time npm setup

The npm account used for the first publication must be allowed to publish the
public `@oh-story/dsh` package. Store a granular publish token as the repository
secret `NPM_TOKEN`; never commit it or put it in an issue, workflow file, or
release note.

After the first publication, configure npm Trusted Publishing for:

- repository: `worldwonderer/oh-story-dsh`
- workflow: `release.yml`

The workflow requests an OpenID Connect identity and publishes with provenance.
Once Trusted Publishing is verified, the long-lived `NPM_TOKEN` secret can be
removed.

## Cut a release

1. Update `packages/dsh-plugin/package.json` and both installation examples to
   the intended version.
2. Run `pnpm verify:release` locally.
3. Commit and push `main`.
4. Create and push the matching tag, for example `v0.1.0`.

The release workflow then:

1. repeats the complete verification suite;
2. builds and inspects a clean installable tarball;
3. checks that the tag and package version match;
4. uploads the tarball and SHA-256 checksum to a GitHub Release;
5. publishes the identical tarball to npm with provenance.

The GitHub Release and npm steps are idempotent so a failed workflow can be
safely re-run.

## Verify the public installation

Do not announce a release until the registry reports the exact version:

```bash
npm view @oh-story/dsh@0.1.0 version dist.integrity
npx -y @deepseek-ai/dsh@0.1.1-rc.1 plugin --profile web add @oh-story/dsh@0.1.0
```

The GitHub Release tarball remains a registry-independent installation path:

```bash
npx -y @deepseek-ai/dsh@0.1.1-rc.1 plugin --profile web add https://github.com/worldwonderer/oh-story-dsh/releases/download/v0.1.0/oh-story-dsh-0.1.0.tgz
```
