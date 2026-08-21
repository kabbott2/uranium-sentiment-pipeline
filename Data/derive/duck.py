"""One DuckDB connection recipe for querying the R2 Parquet in place."""

import duckdb

from .config import Config


def connect(cfg: Config):
    host = cfg.endpoint.removeprefix("https://")
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    # Without this to_timestamp() buckets in local time and day boundaries drift.
    con.execute("SET TimeZone='UTC'")
    con.execute(
        f"""CREATE SECRET r2 (TYPE s3, KEY_ID '{cfg.access_key_id}',
            SECRET '{cfg.secret_access_key}', ENDPOINT '{host}', URL_STYLE 'path')"""
    )
    return con
