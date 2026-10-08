# Node SQLite adapter design

Decision (2026-09-28): @tiana/node-sqlite depends on @tiana/node. The latter owns
endpoint/credential validation and TLS 1.3/H2 CONNECT; this package owns the
hrana-http profile and Hrana v3 JSON HTTP/1.1 POST /v3/pipeline. There are no
compatibility aliases or migration scaffolding, as explicitly requested.

One Session lazily opens one generic Tunnel and owns one rotating baton. The
caller owns Client. Requests are serialized by immediate SESSION_BUSY rejection,
not a queue or pool. execute/query send execute+get_autocommit in one round trip.
Transactions, savepoints and session state stay on that stream. begin/commit/
rollback check autocommit before and after the operation; unknown state poisons
the Session. Raw transaction SQL is allowed and updates observed autocommit.

Native node:http handles HTTP framing through a private Duplex socket adapter.
Its Agent can obtain the existing tunnel once only: no fallback TCP/DNS dial,
redirect, proxy environment use, reconnect or SQL replay. A request deadline
covers connect, write and response. Each operation has its own cancellation
controller; a completed call's signal cannot abort later idle/reused operations.

Integrity and failure rules:
- bigint preserves signed int64 values and unsigned affected-row counts. Unsafe
  integer numbers are rejected. Float explicitly selects finite REAL; fractional
  numbers select REAL, safe integer numbers select INTEGER. No SQL interpolation.
- Decode numbers losslessly. Preflight JSON rejects duplicate keys, prototype
  mutation keys and nesting >128 before the numeric parser. Tagged responses,
  row widths, UTF-8, canonical unpadded blobs and integer ranges are checked.
- Known allowlisted SQL failures retain the baton and observed transaction state.
  Transport, cancellation, malformed response and unknown server errors invalidate
  the stream. outcomeUnknown is conservative after handing a request to HTTP.
  No outcome-unknown operation is retried automatically.
- close sends a bounded explicit Hrana close, which confirms rollback of open
  work only after a valid reply. executeAndClose does not imply COMMIT. abort or
  network loss alone cannot prove rollback; server locks can survive until TTL.
  A closed local object after failed close does not prove server cleanup.
- Bound wire bodies at 8 MiB, response headers at 32 KiB, baton at 4096 UTF-8 bytes,
  JSON nesting at 128. Input serialization and decoded objects require additional
  bounded memory; these are wire caps, not a promise of an 8 MiB heap. Results are
  fully buffered. H2 stream/HTTP backpressure is preserved. No unbounded retries,
  request queue, cache, result cursor, connection pool or background task.
- Error messages and custom inspect output omit SQL, bindings, credentials, baton
  and arbitrary server diagnostics. requestId and bounded codes enable tracing.

No storage format, server locking model, atomicity/durability or crash-recovery
contract is modified. This adapter cannot add storage durability guarantees.
Explicit transactions remain server-owned. On uncertain commit, applications
must reconcile business state before retrying; no fabricated idempotency promise.
Rollback of this code needs no data migration. Dependencies specifications,
control and app_sqlite are read-only; Control does not receive profile selection.

Tradeoffs: one connection per Session and fully buffered results favor explicit
ownership and bounded failure semantics over pooling/cursors. lossless-json is a
pinned runtime dependency for uint64 JSON counters; JSON.parse alone rounds them.
The adapter remains a private development version. Its transport dependency is
the pinned GitHub commit recorded below, with no sibling workspace or local core
tarball dependency. Do not claim public-registry publication.

Validation: native TLS/H2 peers; type/bounds/error/cancellation/transaction tests;
minimum Node 22 and native Node; strict public TypeScript; isolated tarball install;
opt-in real disposable App SQLite for binding, isolation, savepoint, commit,
rollback, constraint-error reuse and explicit-close rollback. Production Gateway,
production durability, browsers/Bun/Deno, cursors/ORM/pooling are outside this run.


## 2026-09-28: API origin and explicit token environment

Use TIANA_API_ORIGIN as the sole API-origin environment name wherever an
origin is loaded. TIANA_MGR_ORIGIN and TIANA_AUTH_ORIGIN are ignored; do not add
compatibility aliases. Explicit API constructor parameters remain available.
Remove TIANA_TOKEN_FILE and raw token-file credential readers. CLI connections
use explicit TIANA_TOKEN (presence is authoritative: empty/malformed fails),
otherwise the selected saved account access token. SDK examples use TIANA_TOKEN;
library constructors continue to accept explicit token values. Never log tokens.
Account credential persistence and refresh locking are separate from raw token
file input and remain intact. No on-disk schema, network protocol or transaction
semantics change. Old environment names deliberately stop working without a
migration fallback. Rollback requires reverting code/docs together.

TIANA_PENDING_COMMAND_FILE, TIANA_CREDENTIALS_FILE and TIANA_GATEWAY_ADDRESS are
under review only; this change does not remove them or pending-operation state.
Keep bounded token validation, existing credential file protections, and explicit
SDK dial overrides. Verify retired names cannot override current configuration,
empty tokens fail closed, saved accounts still work, and runnable SDK examples
accept TIANA_TOKEN without reading a raw token file. No extra network round trips
or file reads may be introduced by environment resolution.


## 2026-09-28: one Gateway address environment name

User requires TIANA_GATEWAY_ADDRESS for example/launcher TCP overrides.
TIANA_DIAL_ADDRESS, TIANA_GATEWAY_HOST and TIANA_GATEWAY_PORT are removed names,
not fallback aliases. Existing explicit SDK Config.DialAddress / gateway options
retain their API names. No implicit environment reads are added to core SDKs.
Endpoint continues to determine TLS SNI, hostname verification and CONNECT
identity. Override only the physical TCP destination, never certificate checks.

Examples consume host:port, with bracketed IPv6. Node example adapters require a
canonical decimal port 1-65535 and reject URLs, credentials, paths and malformed
addresses without echoing the input. Keep these adapters in packaged examples;
do not introduce a public library API for environment parsing. This changes no
wire or storage format, database semantics, retry policy or connection ownership;
parsing adds only bounded work proportional to address input before dialing.
No migration shim: update launch environments, revert code/docs together if needed.
Verify IPv4/hostname/IPv6 parsing, malformed input rejection, installed examples,
and a real TLS/CONNECT exchange with conflicting removed variables present.


## 2026-09-28: verified remote Tiana dependencies

User requires Tiana SDK dependencies to resolve from current GitHub main commits,
never sibling paths or unpublished local builds. Pin verified immutable commits:
sdk-go e69b9c1d3842985e0ba9fd98b2403c520e5f98f1;
sdk-go-sqlite ce8df62d600c6509ef7a3308b17603e68f8c73d7;
sdk-rust f45f14e36313e1ec5787e212de9650c16c9f3067;
sdk-python 940c26c00b9f3abec63537388c4a23b0a129a98a;
sdk-node ba52cb6ec4e751f5158b17d64b45323a82f74f81.
Go records canonical resolved versions and go.sum with GOWORK=off; Rust uses Git
rev and Cargo.lock; Python uses a PEP 508 immutable Git requirement preserved in
wheel metadata; Node uses a Git dependency and package-lock. No local replace,
path patch, workspace link, editable core package or local core tarball fallback.
This supersedes earlier unpublished-core/local-development dependency guidance.

Tradeoff: reproducible builds need GitHub HTTPS access; no SSH key is required.
Future main changes require an explicit pin refresh. Verify fresh
resolution in isolated source copies without sibling repositories, inspecting
module/Cargo/installed Python/npm source metadata, plus relevant tests and package
consumers. Preserve wire, transaction, no-replay, TLS and storage invariants; this
update adds no runtime network round trips or persistence format migration.
No third-party version refresh is intended. Revert manifests and locks together
for rollback. Commit/push/package publication is outside this dependency update.


## 2026-09-28: HTTPS Git dependency

User requires the core SDK Git dependency to use HTTPS, not SSH. Keep the pinned
commit unchanged; synchronize the package manifest, lockfile (where present),
README and built package metadata. No credentials in URLs, SSH/local fallback,
or URL rewrite is allowed to mask validation. Anonymous HTTPS accessibility must
be verified separately; if authentication is required, use HTTPS credentials.
This changes dependency download transport only, with no runtime, wire, storage,
transaction or performance impact. Roll back manifests and lockfiles together.
Verify package metadata and lock consistency, and report any remote-fetch failure
without claiming a successful install. Preserve all existing uncommitted work.


## 2026-09-28: published core fixes dependency refresh

User explicitly authorized commit/push of the three core SDK repositories, then
updating their SQLite adapter dependencies. sdk-node main was pushed and read back
at aed86a52f9d60cac25aea31e271ec0d80b7700ca. Pin this exact immutable remote Git HTTPS revision in the manifest,
README and lockfile where present. Preserve existing adapter implementation,
examples and editor swap files. No local path/link/editable-core dependency and
no third-party version refresh. This brings the opaque credential fix into this
adapter; Rust additionally receives the PEM CA builder API. Existing transport,
no-replay, transaction, storage and resource-bound contracts remain unchanged.
Rollback means restoring the previous pin and corresponding lock/doc together;
it also restores old fixed-format token rejection. Validate installed packages
against the remotely retrieved revision, with source provenance checked, plus
relevant native tests/types/builds. Direct HTTPS authentication is unavailable on
this machine; separately identified remote-transfer validation may use existing
SSH authentication with a process-scoped Git rewrite, never a product dependency
fallback or a claim of anonymous HTTPS success. The production URL remains HTTPS.
Only core repositories were authorized for commit/push; adapter changes remain
uncommitted for review. No SQLite adapter publication is authorized.

## 2026-10-08: v1.0.0 dependency and release verification

User authorizes dependency repair, installed-package and demo validation, then
squashing this repository to one commit and publishing main plus v1.0.0 only.
Use the core v1.0.0 release (Go module version; immutable Git HTTPS revision for
Node/Rust/Python), superseding the old historical pins above. Preserve third-party
versions, TLS verification, no SQL replay and transaction/storage semantics.
Use a disposable local App SQLite for demo verification; never production data.
