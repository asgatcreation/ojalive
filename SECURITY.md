# Security Policy

## Reporting a vulnerability

Please do **not** open a public GitHub issue for a security problem.

Report it privately to **asgatcreation@gmail.com** with:

- what you found and where (URL, endpoint, or file and line),
- how to reproduce it,
- what an attacker could do with it.

You will get an acknowledgement within 72 hours and an assessment within 7 days.
Please give a reasonable window to fix the issue before disclosing it publicly.

## Scope

In scope: the Ojà Live web app, HTTP API, Socket.IO layer, worker, and this
repository's infrastructure configuration.

Out of scope: the hosting providers themselves (Fly.io, Neon, Cloudflare), the
payment providers' own systems, denial-of-service testing against the live demo,
and findings that require physical access to a user's device.

## This is a demonstration deployment

The live demo runs with **sandbox payment keys and demo data only**. It handles no
real money. Please do not submit real personal data, real card details, real
national ID numbers or real BVNs to it.

## How we handle sensitive data

- Raw card numbers are never seen by this application — payments go through the
  provider's hosted checkout.
- IMEI, ID document and BVN values are encrypted at rest, masked in logs and
  masked in staff views.
- Every privileged staff action is written to an append-only audit log.
