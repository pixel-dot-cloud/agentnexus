import React from 'react';
import { Box, Text } from 'ink';

interface StreamBoxProps {
  content: string;
  /** Total height of the box including its border (border = 2 rows). */
  height?: number;
}

export function StreamBox({ content, height = 8 }: StreamBoxProps) {
  if (!content) return null;

  const safeHeight = Math.max(3, height);          // 2 border rows + ≥1 content row
  const bodyRows   = safeHeight - 2;               // rows available for content
  const lines      = content.split('\n');
  const visible    = lines.slice(-bodyRows);       // newest content at bottom

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      height={safeHeight}
      overflow="hidden"
    >
      {visible.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
}
