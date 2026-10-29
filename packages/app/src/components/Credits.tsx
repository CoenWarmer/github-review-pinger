import { Platform } from "@/platform";
import { RingsLoader } from "./RingsLoader";

export function Credits({ platform }: { platform: Platform }) {
  return (
    <>
      <div className="flex items-center justify-center gap-1">
        <RingsLoader size={20} />
        <p className="m-0 py-3 text-center text-xs text-muted-foreground">
          Review Pinger v{platform.version}
        </p>
      </div>
      <div className="flex items-center justify-center mb-4">
        <p className="text-muted-foreground">
          Got feedback?&nbsp;
          <a
            className="underline"
            target="_blank"
            href="https://github.com/CoenWarmer/github-review-pinger/issues"
          >
            Open an issue
          </a>
          .
        </p>
      </div>
    </>
  );
}
