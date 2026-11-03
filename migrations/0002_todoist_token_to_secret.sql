-- The Todoist API token moved from the database to the TODOIST_TOKEN Worker secret.
DELETE FROM settings WHERE key = 'todoist_token';
