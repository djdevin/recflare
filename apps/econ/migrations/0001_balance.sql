-- Currency balances, owned by the `econ` worker. One row per (account, currency):
-- the amount is a real INTEGER column, not a JSON field, so the spend path can be a
-- single atomic `UPDATE ... WHERE amount >= ?` instead of a racy read-modify-write.
--
-- Only account-scoped currencies live here. RoomCurrency (300) / RoomInventoryItem
-- (301) are scoped to a room and belong to the room-currency endpoints — a row here
-- couldn't say which room it was for. Kept in sync with BALANCE_SCHEMA_DDL in
-- src/balance-db.ts.

CREATE TABLE IF NOT EXISTS balance (
  account_id INTEGER NOT NULL,
  currency_type INTEGER NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, currency_type)
  );
