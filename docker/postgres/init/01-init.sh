#!/bin/sh
# Runs once, when the PostgreSQL data volume is first created.
# Turns on PostGIS in the main database and creates the separate test database
# (name taken from POSTGRES_TEST_DB in .env).
set -e

: "${POSTGRES_TEST_DB:?POSTGRES_TEST_DB must be set in .env}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
	CREATE EXTENSION IF NOT EXISTS postgis;
	CREATE DATABASE "$POSTGRES_TEST_DB" OWNER "$POSTGRES_USER";
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_TEST_DB" <<-SQL
	CREATE EXTENSION IF NOT EXISTS postgis;
SQL
