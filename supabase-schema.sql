create table if not exists bookings (
  id text primary key,
  customer_name text,
  service_type text,
  status text,
  created_at timestamptz default now()
);

create table if not exists quotes (
  id text primary key,
  customer_name text,
  service_type text,
  notes text,
  line_items jsonb,
  total numeric,
  created_at timestamptz default now()
);

create table if not exists invoices (
  id text primary key,
  customer_name text,
  email text,
  quote_id text,
  amount numeric,
  status text,
  issued_at timestamptz,
  created_at timestamptz default now()
);
