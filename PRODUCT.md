# Product
<!-- impeccable:product-schema 1 -->
## Platform
web
## Stack
Delegated by the user. TypeScript on Cloudflare Workers, Workers Assets, and a SQLite-backed Durable Object for the independent multiplayer server and query cache; Supabase Postgres is the canonical persistence store. The preserved Bonk browser engine runs in a plain HTML/CSS/JavaScript shell. Node.js/Socket.IO remains available for local development and alternate hosting.
## Users
Tonk.io players seeking the native game with fullscreen play, community maps, host-controlled bots, and custom mods; the owner also needs direct administration tools.
## Product Purpose
An independent game named Tonk.io, based on the pinned Bonk.io client and targeting its original physics, interfaces, editors, modes, and existing feature scope, with true fullscreen and extensibility. The 1:1 goal remains an acceptance target rather than an unconditional parity claim.
## Operating Context
Independent multiplayer with its own room directory, accounts, and persistence. The user explicitly requested Cloudflare Workers and Supabase hosting. Imported public community maps use the native picker and indexed search while retaining creator/source metadata. H644b is the owner account; owners receive administration tools, and room hosts can set bot count and Easy, Normal, Hard, or Expert difficulty in the lobby. See docs/DEPLOYMENT.md and docs/COVERAGE.md for the deployment model and bounded verification evidence.
## Capabilities and Constraints
Use original runtime evidence as acceptance criteria. Distinguish implemented and verified from partial or absent. Official accounts are separate from this server's accounts; the imported community catalog is bounded and retains third-party attribution. Runtime reuse must retain attribution and provenance. Cloud persistence and administration do not imply original private-backend parity, exhaustive map coverage, or verified physical mobile touch play.
## Brand Commitments
Tonk.io is the user-approved product name. The pinned Bonk.io client remains the binding visual and behavioral reference: preserve its Futura PT lettering, teal/brown/gray materials, native controls, and original client/asset attribution. Rebranding does not replace provenance or legacy compatibility identifiers.
## Evidence on Hand
Original HTML, shipped JavaScript, GameResources, and asset manifest under evidence/original. Original website inspected in a browser. Manifold provides a public compatibility protocol reference. Workers configuration and source, the Supabase migration, and operator/coverage documentation record the current implementation. The Tonk review captures show Administration Rooms on desktop and phone; that design review is separate from backend and gameplay verification.
## Product Principles
- Preserve observed behavior and mechanics.
- Give the game the entire viewport.
- Own independent service state and multiplayer routing.
- Make mod activation explicit and reversible.
- Report parity gaps honestly.
