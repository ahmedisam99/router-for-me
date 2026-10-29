import { getAuthFileIcon } from '@/features/authFiles/constants';
import { PROVIDER_LOGOS, type ProviderBrandLogo } from '@/features/providers/brandLogos';
import type { ResolvedTheme } from '@/types';
import { isOpenAICompatible, type CredentialRow } from '../rows';

const brandLogo = (row: CredentialRow): ProviderBrandLogo | null => {
  if (row.resource) return PROVIDER_LOGOS[row.resource.brand] ?? null;
  return isOpenAICompatible(row.credential.provider) ? PROVIDER_LOGOS.openaiCompatibility : null;
};

interface CredentialLogoProps {
  row: CredentialRow;
  theme: ResolvedTheme;
  className?: string;
}

export function CredentialLogo({ row, theme, className }: CredentialLogoProps) {
  const logo = brandLogo(row);
  const src = logo
    ? theme === 'dark' && logo.darkSrc
      ? logo.darkSrc
      : logo.src
    : getAuthFileIcon(row.credential.provider, theme);
  if (!src) {
    return (
      <span className={className} aria-hidden="true">
        {row.credential.provider.charAt(0).toUpperCase()}
      </span>
    );
  }
  return <img src={src} alt="" aria-hidden="true" className={className} />;
}
