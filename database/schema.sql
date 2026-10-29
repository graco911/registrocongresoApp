PRAGMA foreign_keys = ON;

CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    default_fee_cents INTEGER NOT NULL CHECK (default_fee_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'MXN',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE import_batches (
    id INTEGER PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id),
    filename TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    sheet_name TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (event_id, sha256)
);

CREATE TABLE attendees (
    id INTEGER PRIMARY KEY,
    full_name TEXT NOT NULL CHECK (length(trim(full_name)) > 0),
    given_names TEXT,
    surnames TEXT,
    phone TEXT,
    email TEXT,
    church TEXT,
    role TEXT,
    city TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE registrations (
    id INTEGER PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id),
    attendee_id INTEGER NOT NULL REFERENCES attendees(id),
    folio TEXT NOT NULL,
    registration_date TEXT,
    registered_by TEXT,
    fee_cents INTEGER NOT NULL CHECK (fee_cents >= 0),
    notes TEXT,
    import_batch_id INTEGER REFERENCES import_batches(id),
    source_row INTEGER,
    source_data_json TEXT,
    UNIQUE (event_id, folio),
    UNIQUE (event_id, attendee_id),
    UNIQUE (import_batch_id, source_row),
    UNIQUE (id, event_id)
);

CREATE TABLE payments (
    id INTEGER PRIMARY KEY,
    registration_id INTEGER NOT NULL REFERENCES registrations(id),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    kind TEXT NOT NULL CHECK (kind IN ('opening_balance', 'payment')),
    paid_at TEXT,
    method TEXT,
    reference TEXT,
    recorded_by TEXT,
    notes TEXT,
    recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    voided_at TEXT,
    void_reason TEXT,
    CHECK ((voided_at IS NULL AND void_reason IS NULL) OR
           (voided_at IS NOT NULL AND void_reason IS NOT NULL AND length(trim(void_reason)) > 0))
);

CREATE UNIQUE INDEX one_opening_balance
ON payments(registration_id) WHERE kind = 'opening_balance';

CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id),
    name TEXT NOT NULL,
    session_date TEXT,
    UNIQUE (event_id, name),
    UNIQUE (id, event_id)
);

CREATE TABLE checkins (
    id INTEGER PRIMARY KEY,
    event_id INTEGER NOT NULL,
    registration_id INTEGER NOT NULL,
    session_id INTEGER NOT NULL,
    checked_in_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    recorded_by TEXT NOT NULL CHECK (length(trim(recorded_by)) > 0),
    voided_at TEXT,
    void_reason TEXT,
    FOREIGN KEY (registration_id, event_id) REFERENCES registrations(id, event_id),
    FOREIGN KEY (session_id, event_id) REFERENCES sessions(id, event_id),
    CHECK ((voided_at IS NULL AND void_reason IS NULL) OR
           (voided_at IS NOT NULL AND void_reason IS NOT NULL AND length(trim(void_reason)) > 0))
);

CREATE UNIQUE INDEX one_active_checkin
ON checkins(registration_id, session_id) WHERE voided_at IS NULL;

CREATE TABLE import_issues (
    id INTEGER PRIMARY KEY,
    registration_id INTEGER NOT NULL REFERENCES registrations(id),
    field TEXT NOT NULL,
    code TEXT NOT NULL,
    message TEXT NOT NULL,
    resolved_at TEXT
);

CREATE INDEX attendees_name ON attendees(full_name COLLATE NOCASE);
CREATE INDEX attendees_phone ON attendees(phone);
CREATE INDEX attendees_email ON attendees(email COLLATE NOCASE);
CREATE INDEX payments_registration ON payments(registration_id);

CREATE VIEW registration_balances AS
WITH totals AS (
    SELECT r.id AS registration_id, r.event_id, r.attendee_id, r.folio,
           r.fee_cents,
           COALESCE(SUM(CASE WHEN p.voided_at IS NULL THEN p.amount_cents ELSE 0 END), 0)
               AS paid_cents
    FROM registrations r
    LEFT JOIN payments p ON p.registration_id = r.id
    GROUP BY r.id
)
SELECT *,
       MAX(fee_cents - paid_cents, 0) AS balance_cents,
       MAX(paid_cents - fee_cents, 0) AS excess_cents,
       CASE WHEN paid_cents >= fee_cents THEN 'paid'
            WHEN paid_cents > 0 THEN 'partial'
            ELSE 'pending' END AS payment_status
FROM totals;

PRAGMA user_version = 1;
