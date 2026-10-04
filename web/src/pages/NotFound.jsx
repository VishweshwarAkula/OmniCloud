import { ArrowLeft } from "@phosphor-icons/react";
import { Button } from "../components/ui/Button";

export default function NotFound() {
  return (
    <section className="flex min-h-[80dvh] flex-col items-center justify-center px-4 pt-24 text-center">
      <p className="font-mono text-sm text-mint">404</p>
      <h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">This page drifted off.</h1>
      <p className="mt-3 text-mist">The link may be old, or the page never existed.</p>
      <Button to="/" variant="ghost" leading={ArrowLeft} className="mt-8">Home</Button>
    </section>
  );
}
