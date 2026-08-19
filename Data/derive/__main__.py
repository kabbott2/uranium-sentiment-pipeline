import argparse

from .build import run_build, run_check
from .config import from_env
from .report import run_report
from .series import run_series


def main() -> None:
    parser = argparse.ArgumentParser(prog="derive", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    build = sub.add_parser("build", help="convert raw partitions to derived Parquet")
    build.add_argument("--full", action="store_true", help="ignore the manifest and rebuild everything")
    build.add_argument("--subreddit", help="limit to one subreddit")

    report = sub.add_parser("report", help="print the posts/comments-per-month sanity table")
    report.add_argument("--subreddit", help="limit to one subreddit")

    check = sub.add_parser("check", help="exit non-zero if any raw partition is stale in derived")
    check.add_argument("--subreddit", help="limit to one subreddit")

    series = sub.add_parser("series", help="build the daily volume series and store it in R2")
    series.add_argument("--subreddit", default="uraniumsqueeze", help="subreddit to aggregate")

    args = parser.parse_args()
    cfg = from_env()
    if args.command == "build":
        run_build(cfg, full=args.full, only_subreddit=args.subreddit)
    elif args.command == "check":
        run_check(cfg, only_subreddit=args.subreddit)
    elif args.command == "series":
        run_series(cfg, args.subreddit)
    else:
        run_report(cfg, only_subreddit=args.subreddit)


if __name__ == "__main__":
    main()
