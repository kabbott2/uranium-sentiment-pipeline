import argparse

from .bench import run_bench
from .bulk import run_bulk_score
from .config import from_env
from .label import run_label
from .publish import run_publish_lexicon, run_publish_tags
from .review import run_export, run_merge
from .sample import run_sample
from .score import run_score
from .vader import run_vader_distill, run_vader_fit, run_vader_score


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

    score = sub.add_parser("score", help="score the holdout with a Workers AI model")
    score.add_argument("--model", required=True, help="model id, e.g. @cf/openai/gpt-oss-120b")
    score.add_argument("--limit", type=int, help="score only the first N unscored items")
    score.add_argument("--batch", type=int, default=1, help="items per model call (amortizes the prompt)")

    bench = sub.add_parser("bench", help="score agreement against the gold holdout")
    group = bench.add_mutually_exclusive_group(required=True)
    group.add_argument("--scores", help="R2 key of a scorer's JSONL output")
    group.add_argument("--self", action="store_true", dest="self_check",
                       help="bench gold against itself (metric sanity check)")
    bench.add_argument("--collapse3", action="store_true",
                       help="collapse both sides to neg/neu/pos before scoring")

    vader = sub.add_parser("vader", help="domain-adapted VADER scorer")
    vader_sub = vader.add_subparsers(dest="vader_command", required=True)
    vader_score = vader_sub.add_parser("score", help="score the holdout (one holdout spend)")
    vader_score.add_argument("--stock", action="store_true",
                             help="stock VADER baseline, ignore the overlay")
    vader_sub.add_parser("fit", help="threshold grid + miss table on exemplars only")
    vader_sub.add_parser("distill", help="fit the lexicon from the bulk teacher labels")
    vader_sub.add_parser("publish", help="upload the lexicon to model/config/")

    tags = sub.add_parser("tags", help="tag taxonomy artifacts")
    tags_sub = tags.add_subparsers(dest="tags_command", required=True)
    tags_sub.add_parser("publish", help="compile TAGS.md regexes to model/config/")

    bulk = sub.add_parser("bulk", help="bulk teacher scoring over corpus slices")
    bulk_sub = bulk.add_subparsers(dest="bulk_command", required=True)
    bulk_score = bulk_sub.add_parser("score", help="DeepSeek pseudo-labels for the slices (resumable)")
    bulk_score.add_argument("--limit", type=int, help="score only the first N unscored items per slice")

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
    elif args.command == "score":
        run_score(cfg, args.model, limit=args.limit, batch=args.batch)
    elif args.command == "vader" and args.vader_command == "score":
        run_vader_score(cfg, stock=args.stock)
    elif args.command == "vader" and args.vader_command == "fit":
        run_vader_fit(cfg)
    elif args.command == "vader" and args.vader_command == "distill":
        run_vader_distill(cfg)
    elif args.command == "vader":
        run_publish_lexicon(cfg)
    elif args.command == "tags":
        run_publish_tags(cfg)
    elif args.command == "bulk":
        run_bulk_score(cfg, limit=args.limit)
    else:
        run_bench(cfg, args.scores, args.self_check, collapse3=args.collapse3)


if __name__ == "__main__":
    main()
