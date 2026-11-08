-- Keep business and unread versions separate: check-in changes the former only.
-- Older snapshots intentionally retain NULL and must refresh before paging.
-- Their exact-version read receipts remain usable until the original expiry.
ALTER TABLE appointment_inbox_view_items ADD COLUMN appointment_version bigint;
