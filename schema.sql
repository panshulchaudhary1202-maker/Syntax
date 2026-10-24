CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name VARCHAR(100),
  department VARCHAR(140),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS trips (
  id BIGSERIAL PRIMARY KEY,
  organizer_id BIGINT NOT NULL REFERENCES users(id),
  origin VARCHAR(160) NOT NULL,
  destination VARCHAR(100) NOT NULL,
  route VARCHAR(180) NOT NULL DEFAULT '',
  mode VARCHAR(10) NOT NULL CHECK (mode IN ('Car','Train','Bus','Bike','Other')),
  mode_other VARCHAR(80) NOT NULL DEFAULT '',
  trip_date DATE NOT NULL,
  trip_time TIME NOT NULL,
  seats_total INTEGER NOT NULL CHECK (seats_total BETWEEN 1 AND 8),
  cost INTEGER NOT NULL DEFAULT 0 CHECK (cost BETWEEN 0 AND 100000),
  notes VARCHAR(900) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trips_date_idx ON trips(trip_date);
CREATE TABLE IF NOT EXISTS trip_requests (
  id BIGSERIAL PRIMARY KEY,
  trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  requester_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message VARCHAR(500) NOT NULL DEFAULT '',
  status VARCHAR(10) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Accepted','Declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trip_id, requester_id)
);
CREATE INDEX IF NOT EXISTS trip_requests_trip_idx ON trip_requests(trip_id);
