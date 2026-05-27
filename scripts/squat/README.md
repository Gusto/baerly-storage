# Public-name squat placeholders

Two 0.0.0-reserved placeholders published to **public npm** during
Phase 1, blocking dependency-confusion attacks while the real packages
ship privately under @gusto/. Unpublish or upgrade in Phase 2 when the
real packages take their names. See docs/followups/publish-direction.md.

To publish (manual, once):

    cd scripts/squat/baerly-storage && npm publish --registry=https://registry.npmjs.org
    cd ../create-baerly-storage && npm publish --registry=https://registry.npmjs.org
