import argparse

from .build import run_build
from .config import from_env
from .report import run_report


def main() -> None:
    parser = argparse.ArgumentParser(prog="derive", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    build = sub.add_parser("build", help="convert raw partitions to derived Parquet")
    build.add_argument("--full", action="store_true", help="ignore the manifest and rebuild everything")
    build.add_argument("--subreddit", help="limit to one subreddit")

    report = sub.add_parser("report", help="print the posts/comments-per-month sanity table")
    report.add_argument("--subreddit", help="limit to one subreddit")

    args = parser.parse_args()
    cfg = from_env()
    if args.command == "build":
        run_build(cfg, full=args.full, only_subreddit=args.subreddit)
    else:
        run_report(cfg, only_subreddit=args.subreddit)


if __name__ == "__main__":
    main()
