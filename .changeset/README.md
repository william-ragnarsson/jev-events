# Changesets

Every pull request that changes a published package adds a changeset:

```bash
npx changeset
```

Pick the packages, the bump (patch, minor or major) and write one line for the changelog.
All `jev-events` packages are versioned together. When changesets land on `main`, the release
workflow opens a "Version Packages" pull request; merging it publishes to npm.
