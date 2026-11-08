-- Subscription messaging has been removed. Preserve historical records while
-- retiring undelivered jobs so an old queue cannot be replayed on rollback.
UPDATE notifications
SET delivery_status = 'skipped',
    last_error = 'subscription_notifications_removed',
    updated_at = now()
WHERE delivery_status IN ('pending', 'sending', 'failed');
