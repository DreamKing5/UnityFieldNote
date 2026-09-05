-- Replace ONLY the UUID below with Authentication > Users > your confirmed user ID.
-- This is an identifier, not a secret. Never replace with an email or password.
-- Run after schema.sql. Failure rolls back automatically.
BEGIN;
INSERT INTO private.owner(singleton,user_id)
VALUES (true, '00000000-0000-0000-0000-000000000000'::uuid)
ON CONFLICT (singleton) DO UPDATE SET user_id=EXCLUDED.user_id;
COMMIT;
-- If the user does not exist in auth.users, the foreign key will reject it.
