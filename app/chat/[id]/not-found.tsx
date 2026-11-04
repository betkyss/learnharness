import Link from "next/link";
import { TopBar } from "@/components/top-bar";

export default function SessionNotFound() {
 return <div className="flex h-dvh flex-col bg-background text-foreground"><TopBar />
  <div className="m-auto max-w-lg px-6 py-12"><h1 className="text-2xl font-medium">Session not found</h1>
   <p className="mt-3 text-muted-foreground">This session may have been deleted or moved.</p>
   <div className="mt-6 flex gap-4 text-sm"><Link className="underline" href="/">Home</Link><Link className="underline" href="/chat/new">New session</Link></div>
  </div></div>;
}
