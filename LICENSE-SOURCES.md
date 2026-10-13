# License and corresponding source

This revision uses AGPL-3.0-only for Drake-owned software. Third-party
software/assets, user uploads, private records, secrets and service credentials
are not relicensed by this notice. Preserve all dependency licenses and notices.
A dependency API does not automatically make every independent client AGPL;
incorporating or linking covered code needs a separate compatibility review.

## Reproduce the software

Use the Node engine requirement in package.json where present, the committed
lockfile, scripts, schemas/migrations, .env.example, and README.md.

```sh
npm ci
# Configure a local Postgres database using .env.example.
npm run migrate
npm start
```

Use fresh local test services. Do not include a real .env, tokens, database
exports, account information, journals, scripts/books, recordings or uploads
in any source archive. Provide configuration descriptions and schemas instead.
Include the complete source needed to modify and run this exact revision,
including dependency source/notices where required and local modifications.
An npm runtime tarball by itself may omit build inputs: use the full, reviewed
source tree for the corresponding-source offer.

## Hosted source publication gate

The visible Source and license link must offer source for the exact deployed
revision. Set SOURCE_REVISION to its full 40-character git commit.
Public repositories default to their exact-commit GitHub archive. Publish
the commit first and verify the archive is downloadable without authentication.
A custom SOURCE_ARCHIVE_URL must not contain credentials, query tokens or a
fragment. The route rejects incomplete configuration in NODE_ENV=production.
RAILWAY_GIT_COMMIT_SHA is accepted as the revision if SOURCE_REVISION is unset.
Validate the archive actually exists, matches the revision and contains build
and install material before deploying. Syntax checks cannot verify access.
The local preview displays a pending notice until metadata is configured.
Private repository URLs alone do not provide users with corresponding source.

## drake-auth 0.1.2 maintenance preparation

DCC now pins `file:vendor/drake-auth-0.1.2.tgz`, a local, license-only maintenance
release built from v0.1.1. Its runtime source is unchanged; it includes the
standard license and notices. The package-lock.json integrity identifies this
exact artifact. The `codex/agpl-v0.1.2` branch in drake-auth preserves the full
maintenance source. v0.1.1 remains unchanged and UNLICENSED.

No v0.1.2 GitHub tag or package release has been published. Publishing the branch
and an immutable tag requires separate approval. A future switch from the
vendor artifact to that tag must regenerate and verify the lockfile.
