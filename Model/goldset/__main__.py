import argparse

from .bench import run_bench
from .config import from_env
from .label import run_label
from .review import run_export, run_merge
from .sample import run_sample


def main() -> None:
    parser = argparse.ArgumentParser(prog="goldset", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    sample = sub.add_parser("sample", help="draw the stratified sample into R2")
    sample.add_argument("--force", action="store_true", help="overwrite an existing sample")

    label = sub.add_parser("label", help="draft labels with the LLM (resumable)")
    label.add_argument("--limit", type=int, help="label only the first N unlabeled items")

    review = sub.add_parser("review", help="human review round-trip")
    review_sub = review.add_subparsers(dest="review_command", required=True)
    export = review_sub.add_parser("export", help="write the review CSV")
    export.add_argument("--out", required=True, help="path for the review CSV")
    merge = review_sub.add_parser("merge", help="apply an edited review CSV")
    merge.add_argument("--edited", required=True, help="path of the edited review CSV")

    bench = sub.add_parser("bench", help="score agreement against the gold holdout")
    group = bench.add_mutually_exclusive_group(required=True)
    group.add_argument("--scores", help="R2 key of a scorer's JSONL output")
    group.add_argument("--self", action="store_true", dest="self_check",
                       help="bench gold against itself (metric sanity check)")

    args = parser.parse_args()
    cfg = from_env()
    if args.command == "sample":
        run_sample(cfg, force=args.force)
    elif args.command == "label":
        run_label(cfg, limit=args.limit)
    elif args.command == "review" and args.review_command == "export":
        run_export(cfg, args.out)
    elif args.command == "review":
        run_merge(cfg, args.edited)
    else:
        run_bench(cfg, args.scores, args.self_check)


if __name__ == "__main__":
    main()
