import { Component, createRef, type ReactNode } from "react";
import { captureMorph, playMorph, type MorphSnapshot } from "../lib/labelMorph";

type AnimatedWidthProps = {
  children: ReactNode;
  value: string;
  className?: string;
};

/**
 * Lets a label change width smoothly: the label, the button around it and
 * whatever sits beside it glide to their new places on the compositor (see
 * `labelMorph`). Layout itself changes at once, so nothing is laid out per
 * frame and the frame needs no measured width of its own.
 *
 * A class because getSnapshotBeforeUpdate is the one place that runs before
 * React writes the new words, for every label in the commit at once.
 */
export class AnimatedWidth extends Component<AnimatedWidthProps> {
  private frame = createRef<HTMLSpanElement>();

  getSnapshotBeforeUpdate(previous: AnimatedWidthProps): MorphSnapshot | null {
    if (previous.value === this.props.value || !this.frame.current) {
      return null;
    }
    return captureMorph(this.frame.current);
  }

  componentDidUpdate(
    _previous: AnimatedWidthProps,
    _state: unknown,
    snapshot: MorphSnapshot | null,
  ) {
    playMorph(snapshot);
  }

  render() {
    const { children, className = "" } = this.props;
    return (
      <span
        ref={this.frame}
        data-label=""
        className={`relative inline-block align-middle ${className}`}
      >
        <span className="inline-flex items-center justify-center">
          {children}
        </span>
      </span>
    );
  }
}
