CREATE TABLE `records` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`password` text NOT NULL,
	`timeElapsed` integer,
	`body` text
);
