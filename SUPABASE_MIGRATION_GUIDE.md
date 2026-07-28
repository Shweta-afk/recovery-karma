# Supabase Migration Guide

How to apply database migrations for RecoveryAI Tata Tele integration.

---

## Current Migrations

| Date | File | Changes |
|---|---|---|
| 2026-07-28 | `20260728_add_tata_fields_to_agents.sql` | Add `agent_phone`, `provider_agent_id` to agents table (provider-agnostic) |

---

## How to Apply Migrations

### Option 1: Supabase Dashboard (Recommended for small migrations)

1. Go to https://supabase.com/dashboard → select your project
2. Open **SQL Editor** (left sidebar)
3. Click **New Query**
4. Copy the migration file contents (e.g., `src/supabase/migrations/20260728_add_tata_fields_to_agents.sql`)
5. Paste into the editor
6. Click **Run**
7. Confirm: the query succeeds and tables are updated

**Verification:**
```sql
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'agents' 
ORDER BY ordinal_position;
```

You should see `agent_phone` and `provider_agent_id` in the results.

---

### Option 2: Supabase CLI (For automation / CI/CD)

If you have Supabase CLI installed:

```bash
# Link your project
supabase link --project-ref <your-project-ref>

# Push migrations
supabase db push
```

(This assumes migrations are in the standard `supabase/migrations/` folder — which they are.)

---

### Option 3: Local Database (Development)

For local development with `docker-compose`:

```bash
cd src/supabase
docker-compose exec db psql -U postgres -d recovery_karma < migrations/20260728_add_tata_fields_to_agents.sql
```

---

## After Migration

### Update TypeScript Types

If you use Supabase's auto-generated types, regenerate them:

```bash
npm run supabase:generate-types
```

Or manually update `src/lib/types.ts` to add the fields to the `Agent` interface:

```typescript
export interface Agent {
  id: string;
  auth_user_id: string;
  client_id: string;
  name: string;
  email: string;
  role: "agent" | "manager" | "admin";
  daily_target: number;
  is_active: boolean;
  tata_agent_number?: string;  // NEW
  tata_agent_id?: string;       // NEW
  created_at: string;
}
```

### Verify in Production

After deploying to production:

1. Check Supabase dashboard → your project → Table Editor
2. Open `agents` table
3. Confirm new columns are present
4. (No existing agents will have values yet — that's expected)

---

## Migration Checklist

- [ ] Migration file created in `src/supabase/migrations/`
- [ ] Migration file run against Supabase database (via dashboard or CLI)
- [ ] Schema verified (columns visible in table editor)
- [ ] TypeScript types updated (if applicable)
- [ ] Code changes deployed that reference new columns
- [ ] Rollback plan documented (see below)

---

## Rollback Plan

If a migration causes issues:

### Rollback Option 1: Delete the columns (if not critical)

```sql
ALTER TABLE agents DROP COLUMN tata_agent_number;
ALTER TABLE agents DROP COLUMN tata_agent_id;
```

Then revert the code changes (git checkout previous commit).

### Rollback Option 2: Full database restore (if data was corrupted)

1. Go to Supabase dashboard → your project → **Database** → **Backups**
2. Restore to a point-in-time before the migration
3. Re-apply migrations in the correct order

---

## Future Migrations

When adding new migrations:

1. Create a new file: `src/supabase/migrations/YYYYMMDD_description.sql`
2. Write idempotent SQL (use `IF NOT EXISTS`, `IF EXISTS` where applicable)
3. Test locally first
4. Apply via Supabase dashboard or CLI
5. Update `schema.sql` to match the final state
6. Commit both files to git
7. Update this guide

### Naming Convention

```
YYYYMMDD_snake_case_description.sql

Examples:
- 20260728_add_tata_fields_to_agents.sql
- 20260801_create_tata_webhook_logs.sql
- 20260815_add_call_recording_index.sql
```

---

## Notes

- Migrations are **immutable** — once applied, they stay in `migrations/` folder
- Never edit a migration after it's been applied to any environment
- Always test migrations in a staging environment first
- Keep `schema.sql` in sync with actual schema for reference
