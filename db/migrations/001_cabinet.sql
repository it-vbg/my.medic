CREATE TABLE medic.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100 AND name = btrim(name) AND name !~ '[[:cntrl:]]'),
  email text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND char_length(email) <= 254
    AND email !~ '[[:cntrl:]]' AND email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
  password_salt bytea NOT NULL CHECK (octet_length(password_salt) = 16),
  password_hash bytea NOT NULL CHECK (octet_length(password_hash) = 64),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE medic.registrations (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100 AND name = btrim(name) AND name !~ '[[:cntrl:]]'),
  email text NOT NULL CHECK (email = lower(btrim(email)) AND char_length(email) <= 254
    AND email !~ '[[:cntrl:]]' AND email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
  password_salt bytea NOT NULL CHECK (octet_length(password_salt) = 16),
  password_hash bytea NOT NULL CHECK (octet_length(password_hash) = 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX registrations_email ON medic.registrations (email);
CREATE INDEX registrations_expiry ON medic.registrations (expires_at);

CREATE TABLE medic.sessions (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  account_id uuid NOT NULL REFERENCES medic.accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_account ON medic.sessions (account_id);
CREATE INDEX sessions_expiry ON medic.sessions (expires_at);

CREATE TABLE medic.cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES medic.accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('self', 'child')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100 AND name = btrim(name) AND name !~ '[[:cntrl:]]'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cards_one_self ON medic.cards (owner_id) WHERE kind = 'self';
CREATE INDEX cards_owner ON medic.cards (owner_id);

CREATE TABLE medic.card_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES medic.cards(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(btrim(email)) AND char_length(email) <= 254
    AND email !~ '[[:cntrl:]]' AND email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
  recipient_id uuid REFERENCES medic.accounts(id) ON DELETE CASCADE,
  code_hash bytea UNIQUE CHECK (octet_length(code_hash) = 32),
  expires_at timestamptz,
  UNIQUE (card_id, email),
  CHECK ((recipient_id IS NULL AND code_hash IS NOT NULL AND expires_at IS NOT NULL)
      OR (recipient_id IS NOT NULL AND code_hash IS NULL AND expires_at IS NULL))
);
CREATE UNIQUE INDEX grants_recipient_card ON medic.card_grants (recipient_id, card_id) WHERE recipient_id IS NOT NULL;

CREATE TABLE medic.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES medic.cards(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 140 AND btrim(title) <> '' AND title !~ '[[:cntrl:]]'),
  category text NOT NULL CHECK (category IN ('analysis', 'examination')),
  exam_date date NOT NULL CHECK (exam_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 200 AND btrim(filename) <> ''
    AND filename !~ '[[:cntrl:]/]' AND strpos(filename, chr(92)) = 0),
  mime text NOT NULL CHECK (mime IN ('application/pdf', 'image/jpeg', 'image/png')),
  created_at timestamptz NOT NULL DEFAULT now(),
  bytes bytea NOT NULL,
  size integer GENERATED ALWAYS AS (octet_length(bytes)) STORED CHECK (size BETWEEN 1 AND 12582912)
);
CREATE INDEX documents_card_date ON medic.documents (card_id, exam_date DESC, created_at DESC, id);
