-- 004: the canonical expense categories.
--
-- Seeded from expense_weight.json at the repo root, which stays the source of
-- truth. The app re-syncs these rows on startup, so editing the JSON and
-- restarting is enough to update the database.
--
--   weight      — importance, 1 (Gaming) to 10 (Housing)
--   avg_monthly — typical monthly spend, used as the budget baseline

CREATE TABLE IF NOT EXISTS expense_categories (
    category    VARCHAR(80) PRIMARY KEY,
    weight      SMALLINT     NOT NULL CHECK (weight BETWEEN 0 AND 10),
    avg_monthly NUMERIC(12,2) NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

INSERT INTO expense_categories (category, weight, avg_monthly) VALUES
    ('Housing',                 10, 1400),
    ('Utilities',               10,  600),
    ('Gas & Fuel',               8,  200),
    ('Groceries',               10,  500),
    ('Dining & Restaurants',      4,  250),
    ('Transportation',           6,   80),
    ('Auto & Vehicle',           8,  150),
    ('Travel',                   3,  200),
    ('Entertainment',            2,   60),
    ('Shopping',                 5,  150),
    ('Games & Gaming',           1,   25),
    ('Healthcare',              10,  350),
    ('Fitness & Wellness',       5,   50),
    ('Personal Care',            4,   60),
    ('Subscriptions & Services', 3,   50),
    ('Education',                9,  150),
    ('Work & Professional',      9,  100),
    ('Family',                   8,  400),
    ('Pets',                     8,  100),
    ('Gifts & Donations',        1,   80),
    ('Household',                4,  120)
ON CONFLICT (category) DO UPDATE
SET weight      = EXCLUDED.weight,
    avg_monthly = EXCLUDED.avg_monthly,
    updated_at  = now();
