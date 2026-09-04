import type { AnchorHTMLAttributes, ReactNode } from 'react';

type UniversalLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  children?: ReactNode;
  to?: string;
};

export function UniversalLink({ children, to, href, ...props }: UniversalLinkProps) {
  return <a {...props} href={href || to} target={props.target || '_blank'} rel={props.rel || 'noreferrer'}>{children}</a>;
}
