# Garage as Cloud Threads snapshot storage

## Status: deferred beyond v1

The subsequent product decision is to keep all Tower persistent application data, including snapshot BLOBs, in one SQLite database for v1. The [handoff spec](../specs/cloud-threads-v1.md) is authoritative. No S3 integration or multi-backend framework is required for this release.

Garage remains a suitable candidate for a later immutable snapshot backend. In that design, keep the thread catalog, latest-revision pointers, command receipts, and ownership coordination in Tower; keep active pi session files and the runner journal on the runner's local filesystem.

The recommendations below describe that future option, not a tested integration or a v1 requirement. Adding S3 would move snapshot BLOBs out of SQLite and require a new publication/migration contract; it would not replace the catalog or runner persistence.

## Evidence and source scope

Primary sources were read from the official Garage website and its GitHub mirror at commit `871a472da0180e5cfe75c4438da7f1e273e82f1b`. A repository checkout can contain unreleased changes; validate against the exact release selected for deployment.

The delegated research run `9ff55957-5358-4b85-8acf-c1ba82bb1479` was blocked because its web tools were not registered. It stopped without modifying files. The parent session independently fetched and inspected the sources below and wrote this note.

### Basic object APIs and versioning

The [official S3 compatibility table](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/) lists PutObject, GetObject, HeadObject, DeleteObject, path-style URLs and presigned URLs as implemented. These cover the basic snapshot use case.

The same page states:

> Garage does not (yet) support object versioning.

Use application-assigned immutable keys instead of S3 bucket versioning. For example:

```text
threads/<thread-id>/snapshots/<revision>/<sha256>.json
```

Immutability here is an application rule, not storage-enforced WORM. Do not overwrite `latest.json`; store the latest committed key/revision in SQLite.

### Read-after-write is configurable

The [configuration reference](https://github.com/deuxfleurs-org/garage/blob/871a472da0180e5cfe75c4438da7f1e273e82f1b/doc/book/reference-manual/configuration.md#consistency_mode) describes `consistent` as the default:

> The read and write quorum will be determined so that read-after-write consistency is guaranteed.

For replication factor 3, the table gives write quorum 2 and read quorum 2. `degraded` lowers the read quorum and no longer guarantees read-after-write; `dangerous` lowers both quorums. Require `consistent` for this integration.

Do not describe Garage generically as an eventually consistent object API. Conversely, object read-after-write does not supply conditional-write exclusion or a transaction spanning SQLite and S3.

The [2023 consistency blog](https://garagehq.deuxfleurs.fr/blog/2023-12-preserving-read-after-write-consistency/) documents historical v0.9.0 layout-change limitations and a proposed fix. It is useful design context, not sufficient evidence about a selected modern release. Test acknowledged Put/Get across the deployment's actual endpoints, restarts and supported maintenance procedures.

### Conditional writes cannot implement ownership

The [known-issues document](https://github.com/deuxfleurs-org/garage/blob/871a472da0180e5cfe75c4438da7f1e273e82f1b/doc/book/reference-manual/known-issues.md) explicitly lists:

> No conditional writes / locking / WORM support (`if-none-match`, ...)

It explains that concurrent write exclusion cannot be implemented safely under Garage's design and specifically identifies mutual exclusion between concurrent writers as an unsupported use case.

Therefore do not use S3 lock objects, `If-None-Match: *`, object retention, or object overwrite races to implement browser ownership, command deduplication, or snapshot revision allocation. Those remain Tower/runner responsibilities.

### Deployment and encryption

Garage's [README](https://github.com/deuxfleurs-org/garage/blob/871a472da0180e5cfe75c4438da7f1e273e82f1b/README.md) describes it as S3-compatible object storage for small-to-medium self-hosted deployments and geographically distributed nodes.

The [configuration reference](https://github.com/deuxfleurs-org/garage/blob/871a472da0180e5cfe75c4438da7f1e273e82f1b/doc/book/reference-manual/configuration.md#replication_factor) warns that replication factor 1 has no redundancy and should only be used for testing. With factor 3, reads and writes can continue when a single node is unavailable, subject to the described placement assumptions. Three containers sharing one host/disk are not three independent failure domains.

The [encryption guide](https://github.com/deuxfleurs-org/garage/blob/871a472da0180e5cfe75c4438da7f1e273e82f1b/doc/book/cookbook/encryption.md) states that Garage's HTTP APIs are cleartext and recommends a TLS reverse proxy or secure network. Standard S3 requests do not automatically encrypt data at rest; SSE-C is supported but requires client-supplied keys. Do not infer automatic encryption from S3 compatibility.

The older `reference_manual/s3_compatibility.html` page says encryption is unimplemented, while the newer guide describes SSE-C. Prefer release-specific source/docs and avoid relying on the older page.

## Recommended integration contract

1. Tower owns the S3 credentials; browsers continue using Tower authentication. Runners upload through Tower in v1. No Garage-specific admin API is required at runtime.
2. Configure endpoint, region, bucket, prefix, access credentials and path-style addressing. Provision the bucket outside the application; avoid broad bucket-administration permissions.
3. Runtime needs PutObject/GetObject/HeadObject. ListObjectsV2 and DeleteObject are optional maintenance operations, not prerequisites for building the thread list.
4. Serialize the complete snapshot, compute the application SHA-256, and PUT to its immutable key. Same key retries must contain identical bytes. Do not treat ETag as the application's SHA-256.
5. On successful PUT, commit the snapshot key/hash/revision and latest pointer in a SQLite transaction. Only then send the cloud-sync acknowledgement. Publication must also preserve existing revision/hash conflict checks.
6. A crash between upload and DB commit may leave an unreferenced object. Retrying can reuse it. Never publish a DB pointer before the object upload succeeds; do not attempt rollback by deleting an object that a concurrent retry might publish.
7. Unknown PUT outcome: retry identical bytes or retrieve and verify the object before publication. Provider acceptance tests must establish the required read-after-write behavior; bounded retries are not a substitute for that contract.
8. Preserve the runner outbox during object-store outages. A completed run can remain `pending` sync; the UI must not report `synced` early.
9. Back up SQLite consistently as well as snapshot objects. An S3 copy of a live SQLite/WAL file is not a database replication or backup protocol.
10. Do not mount the bucket as the active pi/SQLite filesystem. S3 stores completed immutable objects, not in-place append logs or database locks.

## Tests before calling Garage supported

- Put/Get/Head through the chosen SDK and exact Garage release, including payload checksums, path-style addressing, signing and upload-size limits.
- Same object retry, timeout after successful upload, duplicate revision with different hash, and DB commit failure after successful upload.
- Restart Tower with its database intact; read all referenced objects and resume the original runner thread.
- Object-store outage during a run, retry/backpressure, and final `synced` acknowledgement only after publication.
- Read acknowledged objects through each configured endpoint; node failure and maintenance scenarios for the deployed topology.
- Coordinated database/object backup and restore; no object lifecycle rule deletes a still-referenced snapshot.

## Operational recommendation

If an existing Garage cluster is available, use its S3 endpoint through a small snapshot-store boundary. If pi-tower would be its only consumer on one machine, Garage adds service operations without creating independent redundancy; local snapshot files or a managed S3 service may be a simpler starting point. Keep the backend S3-compatible rather than tying the product to Garage.
